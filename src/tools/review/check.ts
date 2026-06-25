import type {
  CiClassificationOutput,
  PullRequestCheck,
  PullRequestChecks,
  PullRequestClassifiedChecks,
  PullRequestMetadata,
} from "./index.type"
import type { Review } from "./review"
import picomatch from "picomatch"
import { MagiError } from "@/magi"
import { Prompt } from "@/prompts"
import {
  command,
  filterEmpty,
  isNumber,
  omitNullish,
  quote,
  retry,
  Worker,
} from "@/utils"

const ci = {
  isExcluded(exclude: string[], { name }: PullRequestCheck): boolean {
    return exclude.some((pattern) => {
      if (
        pattern.startsWith("/") &&
        pattern.endsWith("/") &&
        pattern.length > 1
      )
        return new RegExp(pattern.slice(1, -1)).test(name)

      return pattern === name
    })
  },
  isFailed(check: PullRequestCheck): boolean {
    return check.bucket === "fail" || check.state === "FAILURE"
  },
  isPassed(check: PullRequestCheck): boolean {
    return check.bucket === "pass" || check.state === "SUCCESS"
  },
  isPending(check: PullRequestCheck): boolean {
    return !this.isFailed(check) && !this.isPassed(check)
  },
}

export async function checkPr(this: Review): Promise<void> {
  this.context.abort.throwIfAborted()

  await this.magi.updateState(this.state.output, {
    status: "running",
    text: `Checking PR ${this.getLink()}.`,
  })

  const { files, metadata } = await getMetadata.call(this)

  if (metadata.state !== "open")
    throw new MagiError("blocked", `PR is not open.`)
  if (metadata.draft) throw new MagiError("blocked", `PR is a draft.`)

  const errors: string[] = []

  if (this.config.review.safety.allowAuthors.length)
    if (!this.config.review.safety.allowAuthors.includes(metadata.user.login))
      errors.push(`Author is not allowed: ${metadata.user.login}.`)

  if (this.config.review.safety.requiredLabels.length) {
    const missingLabels = this.config.review.safety.requiredLabels.filter(
      (label) => !metadata.labels.some(({ name }) => name === label),
    )

    if (missingLabels.length)
      errors.push(`Required labels missing: ${missingLabels.join(", ")}.`)
  }

  if (
    isNumber(this.config.review.safety.maxChangedFiles) &&
    metadata.changed_files > this.config.review.safety.maxChangedFiles
  )
    errors.push(
      `Changed files exceed limit: ${metadata.changed_files} > ${this.config.review.safety.maxChangedFiles}.`,
    )

  if (this.config.review.safety.blockedPaths.length) {
    const isBlocked = picomatch(this.config.review.safety.blockedPaths, {
      dot: true,
    })
    const blocked = files.filter((file) => isBlocked(file))

    if (blocked.length)
      errors.push(`Blocked paths changed: ${blocked.join(", ")}.`)
  }

  if (errors.length)
    throw new MagiError("blocked", `PR is safety blocked. ${errors.join(" ")}`)

  this.state = await this.magi.updateState(this.state.output, {
    pr: { files, metadata },
    text: `Finished checking PR ${this.getLink()}.`,
  })
}

export async function checkCi(
  this: Review,
  wait = this.config.review.checks.wait,
): Promise<void> {
  this.context.abort.throwIfAborted()

  this.state = await this.magi.updateState(this.state.output, {
    text: `Checking CI for ${this.getLink()}.`,
  })

  if (wait) await watchChecks.call(this)

  const checks = await getChecks.call(this)

  this.state = await this.magi.updateState(this.state.output, {
    pr: { checks },
    text: `Finished checking CI for ${this.getLink()}.`,
  })
}

export async function classifyChecks(this: Review): Promise<void> {
  this.context.abort.throwIfAborted()

  if (!this.state.pr?.checks?.failed.length) return

  await this.magi.updateState(this.state.output, {
    text: `Classifying CI checks for ${this.getLink()}.`,
  })

  if (!this.state.pr.metadata)
    throw new MagiError("blocked", "PR metadata not found.")
  if (!this.state.worktree)
    throw new MagiError("blocked", "PR worktree not found.")

  const worker = new Worker(this.config.review.concurrency.reviewers)
  const classifiedChecks: { [key: string]: PullRequestClassifiedChecks } =
    Object.fromEntries(this.state.pr.checks.failed.map(({ id }) => [id, {}]))
  const command = this.state.command === "merge" ? "merge" : "review"
  const prompt = await Prompt.init(
    this.magi,
    this.config,
    `${command}/ci-classification`,
  )
  const taskMessage = await prompt.create(
    this.config[command].prompts?.ciClassification,
    ["output_contract"],
    {
      baseSha:
        this.state.pr.metadata[this.state.command === "merge" ? "head" : "base"]
          .sha,
      failedChecks: JSON.stringify(this.state.pr.checks.failed, null, 2),
      headSha: this.state.pr.metadata.head.sha,
      owner: this.config.github.owner,
      pr: this.number.toString(),
      repo: this.config.github.repo,
      worktreePath: this.state.worktree.path,
    },
  )
  const repairMessage = await prompt.repair()

  await Promise.all(
    Object.entries(this.state.reviewers ?? {}).map(([id, { sessionId }]) =>
      worker.run(async () => {
        if (!sessionId)
          throw new Error(`No session ID found for reviewer ${id}.`)

        await this.magi.notify(
          this.state.sessionId,
          `Classifying CI checks for ${this.getLink()} with reviewer ${id}.`,
        )

        const output = await retry(
          async (count) => {
            const raw = await this.magi.promptSession(
              sessionId,
              count === 1 ? taskMessage : repairMessage,
            )
            const parsed = prompt.parse(raw)

            if (!prompt.validate<CiClassificationOutput>(parsed))
              throw new Error(`Invalid output for reviewer ${id}.`)

            return parsed
          },
          {
            error: (_, count) =>
              this.magi.notify(
                this.state.sessionId,
                `Attempt ${count} failed to classify CI checks for ${this.getLink()} with reviewer ${id}. Retrying...`,
              ),
            retries: this.config.output.repairAttempts,
          },
        )

        if (!output)
          throw new MagiError("blocked", `Invalid output for reviewer ${id}.`)

        output.checks.forEach((data) => {
          classifiedChecks[data.id]![id] = {
            comment: data.comment,
            scope: data.classification === "SCOPE_IN",
          }
        })
      }),
    ),
  )

  const failed = this.state.pr.checks.failed.map((check) => {
    const classifieds = classifiedChecks[check.id]!
    const values = Object.values(classifieds)
    const scope =
      values.reduce((acc, { scope }) => acc + (scope ? 1 : 0), 0) >
      values.length / 2

    return { ...check, classifieds, scope }
  })

  await Promise.all(
    failed.map(async ({ classifieds, name, scope }) => {
      const reasons = {
        in: Object.entries(classifieds)
          .filter(([, { scope }]) => scope)
          .map(([id, { comment }]) => `- ${id}: ${comment}`),
        out: Object.entries(classifieds)
          .filter(([, { scope }]) => !scope)
          .map(([id, { comment }]) => `- ${id}: ${comment}`),
      }

      await this.magi.notify(
        this.state.sessionId,
        filterEmpty([
          scope
            ? `Check ${name} for ${this.getLink()} was classified as in scope by majority vote.`
            : `Check ${name} for ${this.getLink()} was classified as out of scope by majority vote. Rerunning it.`,
          reasons.in.length
            ? `In scope reasons:\n${reasons.in.join("\n")}`
            : undefined,
          reasons.out.length
            ? `Out of scope reasons:\n${reasons.out.join("\n")}`
            : undefined,
        ]).join("\n\n"),
      )
    }),
  )

  this.state = await this.magi.updateState(this.state.output, {
    pr: { checks: { failed } },
    text: `Finished classifying CI checks for ${this.getLink()}.`,
  })
}

export async function rerunChecks(this: Review): Promise<void> {
  this.context.abort.throwIfAborted()

  if (!this.state.pr?.checks)
    throw new MagiError("blocked", "PR checks not found.")

  const checks = {
    failed: this.state.pr.checks.failed,
    passed: this.state.pr.checks.passed,
  }
  const failedChecks = checks.failed.filter(({ scope }) => !scope)

  if (!failedChecks.length) return

  await this.magi.updateState(this.state.output, {
    text: `Rerunning CI checks for ${this.getLink()}.`,
  })

  let label = failedChecks.map(({ name }) => name).join(", ")

  if (this.state.dryRun) {
    checks.passed = [
      ...checks.passed,
      ...checks.failed.filter(({ scope }) => !scope),
    ]
    checks.failed = checks.failed.filter(({ scope }) => scope)
  } else {
    await retry(
      async () => {
        await this.magi.notify(
          this.state.sessionId,
          `Rerunning checks ${label} for ${this.getLink()}.`,
        )
        await Promise.all(
          checks.failed
            .filter(({ scope }) => !scope)
            .map(async ({ id }) => rerunCheck.call(this, id)),
        )
        await watchChecks.call(this)

        const { failed, passed } = await getChecks.call(this)

        checks.passed = passed.map((check) => {
          const { classifieds, scope } =
            checks.failed.find(
              ({ name, workflow }) =>
                check.name === name && check.workflow === workflow,
            ) ?? {}

          return omitNullish({ ...check, classifieds, scope })
        })
        checks.failed = failed.map((check) => {
          const { classifieds, scope } =
            checks.failed.find(
              ({ name, workflow }) =>
                check.name === name && check.workflow === workflow,
            ) ?? {}

          return omitNullish({ ...check, classifieds, scope })
        })

        const failedChecks = checks.failed.filter(({ scope }) => !scope)

        if (!failedChecks.length) return

        label = failedChecks.map(({ name }) => name).join(", ")

        throw new Error(`Checks ${label} for ${this.getLink()} still failed.`)
      },
      {
        error: (_, count) =>
          this.magi.notify(
            this.state.sessionId,
            `Attempt ${count} failed to rerun checks ${label} for ${this.getLink()}. Retrying...`,
          ),
        retries: this.config.review.checks.retryFailedJobs,
      },
    )
  }

  const passedChecksAfterRerun = checks.passed.filter(
    (check) => "scope" in check && !check.scope,
  )
  const failedChecksAfterRerun = checks.failed.filter(({ scope }) => !scope)
  const message = filterEmpty([
    passedChecksAfterRerun.length
      ? `Reran checks ${passedChecksAfterRerun.map(({ name }) => name).join(", ")} for ${this.getLink()} passed.`
      : undefined,
    failedChecksAfterRerun.length
      ? `Reran checks ${failedChecksAfterRerun.map(({ name }) => name).join(", ")} for ${this.getLink()} failed.`
      : undefined,
  ]).join("\n")

  if (message) await this.magi.notify(this.state.sessionId, message)

  this.state = await this.magi.updateState(this.state.output, {
    pr: { checks },
    text: `Finished rerunning checks for ${this.getLink()}.`,
  })
}

export async function getMetadata(
  this: Review,
): Promise<{ files: string[]; metadata: PullRequestMetadata }> {
  const [{ data }, files] = await Promise.all([
    this.octokit.rest.pulls.get({
      owner: this.config.github.owner,
      pull_number: this.number,
      repo: this.config.github.repo,
    }),
    this.octokit.paginate(this.octokit.rest.pulls.listFiles, {
      owner: this.config.github.owner,
      pull_number: this.number,
      repo: this.config.github.repo,
    }),
  ])

  return { files: files.map(({ filename }) => filename), metadata: data }
}

async function getChecks(this: Review): Promise<PullRequestChecks> {
  const fields = "name,state,bucket,link,workflow"
  const checks: PullRequestChecks = {
    excluded: [],
    failed: [],
    passed: [],
    pending: [],
  }

  try {
    const raw = await this.exec(
      command(
        "gh",
        "pr",
        "checks",
        this.number,
        "--repo",
        this.state.repo,
        "--json",
        fields,
        "--required",
      ),
      { signal: this.context.abort },
    )
    const data = JSON.parse(raw) as PullRequestCheck[]

    await Promise.all(
      data.map(async (check) => {
        check.id = check.link.match(/\/actions\/runs\/\d+\/job\/(\d+)/)![1]!

        if (ci.isExcluded(this.config.review.checks.exclude, check)) {
          checks.excluded.push(check)
        } else if (ci.isFailed(check)) {
          const log = await getCheckLog.call(this, check.id)

          checks.failed.push({ ...check, log })
        } else if (ci.isPassed(check)) {
          checks.passed.push(check)
        } else if (ci.isPending(check)) {
          checks.pending.push(check)
        }
      }),
    )
  } catch (e) {
    if (!/no (required )?checks reported on the '.+' branch/i.test(String(e)))
      throw e
  }

  return checks
}

async function getCheckLog(this: Review, id: string): Promise<string> {
  const log = await this.exec(
    command(
      "gh",
      "run",
      "view",
      "--repo",
      this.state.repo,
      "--job",
      quote(id),
      "--log-failed",
    ),
    { signal: this.context.abort },
  )

  return (
    log
      // oxlint-disable-next-line no-control-regex
      .replaceAll(/\u001B\[[0-9;]*m/g, "")
      .split("\n")
      .filter((line) => line.trim())
      .join("\n")
  )
}

async function rerunCheck(this: Review, id: string): Promise<void> {
  await this.exec(
    command(
      "gh",
      "run",
      "rerun",
      "--repo",
      this.state.repo,
      "--job",
      quote(id),
    ),
    { signal: this.context.abort },
  )
}

async function watchChecks(this: Review): Promise<void> {
  try {
    await this.exec(
      command(
        "gh",
        "pr",
        "checks",
        this.number,
        "--repo",
        this.state.repo,
        "--watch",
        "--required",
      ),
      { signal: this.context.abort },
    )
  } catch {}
}
