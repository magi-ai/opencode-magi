import type { ToolContext } from "@opencode-ai/plugin"
import type { Octokit } from "octokit"
import type {
  CiClassificationOutput,
  FindingValidationOutput,
  PullRequestCheck,
  PullRequestChecks,
  PullRequestClassifiedChecks,
  PullRequestInlineCommentTargets,
  ReviewOutput,
} from "./index.type"
import type { Config } from "@/config"
import type { Graphql } from "@/graphql"
import type { Magi, ReviewerState, State } from "@/magi"
import type { PromptTag } from "@/prompts"
import type { Exec } from "@/utils"
import { join } from "node:path"
import picomatch from "picomatch"
import { MagiError } from "@/magi"
import { Prompt } from "@/prompts"
import {
  command,
  createExecWithGitHubApiRetry,
  filterDuplicates,
  filterEmpty,
  isNumber,
  omitNullish,
  quote,
  retry,
  toTitleCase,
  Worker,
} from "@/utils"

const ci = {
  isExcluded(exclude: string[], { name }: PullRequestCheck) {
    return exclude.some((pattern) => {
      if (
        pattern.startsWith("/") &&
        pattern.endsWith("/") &&
        pattern.length > 1
      ) {
        return new RegExp(pattern.slice(1, -1)).test(name)
      }

      return pattern === name
    })
  },
  isFailed(check: PullRequestCheck) {
    return check.bucket === "fail" || check.state === "FAILURE"
  },
  isPassed(check: PullRequestCheck) {
    return check.bucket === "pass" || check.state === "SUCCESS"
  },
  isPending(check: PullRequestCheck) {
    return !this.isFailed(check) && !this.isPassed(check)
  },
}

interface ReviewOptions {
  dryRun: boolean
}

export class Review {
  public state: State

  constructor(
    private number: number,
    private magi: Magi,
    private config: Config.Root,
    private context: ToolContext,
    private octokit: Octokit,
    private graphql: Graphql,
    private exec: Exec,
    state: State,
  ) {
    this.exec = createExecWithGitHubApiRetry(
      this.magi.exec,
      this.config.github.retryApiAttempts,
    )
    this.state = state
  }

  static async init(
    number: number,
    magi: Magi,
    config: Config.Root,
    context: ToolContext,
    options: ReviewOptions,
  ) {
    const url = `${config.github.url}/pull/${number}`
    const octokit = await magi.createOctokit(config, context.abort)
    const graphql = magi.createGraphql(octokit)
    const state = await magi.createState(
      join(config.review.output, number.toString()),
      {
        command: "review",
        dryRun: options.dryRun,
        pr: { number, url },
        repo: quote(`${config.github.owner}/${config.github.repo}`),
        sessionId: context.sessionID,
        text: `Started reviewing [#${number}](${url}).`,
      },
    )
    const exec = createExecWithGitHubApiRetry(
      magi.exec,
      config.github.retryApiAttempts,
    )

    return new Review(
      number,
      magi,
      config,
      context,
      octokit,
      graphql,
      exec,
      state,
    )
  }

  public getLink() {
    return `[#${this.state.pr!.number}](${this.state.pr!.url})`
  }

  public async checkPr() {
    this.context.abort.throwIfAborted()

    await this.magi.updateState(this.state.output, {
      status: "running",
      text: `Checking PR ${this.getLink()}.`,
    })

    const { files, metadata } = await this.getMetadata()

    if (metadata.state !== "open")
      throw new MagiError("blocked", `PR is not open.`)
    if (metadata.draft) throw new MagiError("blocked", `PR is a draft.`)

    const errors: string[] = []

    if (this.config.review.safety.allowAuthors.length) {
      if (!this.config.review.safety.allowAuthors.includes(metadata.user.login))
        errors.push(`Author is not allowed: ${metadata.user.login}.`)
    }

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
    ) {
      errors.push(
        `Changed files exceed limit: ${metadata.changed_files} > ${this.config.review.safety.maxChangedFiles}.`,
      )
    }

    if (this.config.review.safety.blockedPaths.length) {
      const isBlocked = picomatch(this.config.review.safety.blockedPaths, {
        dot: true,
      })
      const blocked = files.filter((file) => isBlocked(file))

      if (blocked.length)
        errors.push(`Blocked paths changed: ${blocked.join(", ")}.`)
    }

    if (errors.length) {
      throw new MagiError(
        "blocked",
        `PR is safety blocked. ${errors.join(" ")}`,
      )
    }

    this.state = await this.magi.updateState(this.state.output, {
      pr: { files, metadata },
      text: `Finished checking PR ${this.getLink()}.`,
    })
  }

  public async checkCi() {
    this.context.abort.throwIfAborted()

    this.state = await this.magi.updateState(this.state.output, {
      text: `Checking CI for ${this.getLink()}.`,
    })

    if (this.config.review.checks.wait) await this.watchChecks()

    const checks = await this.getChecks()

    this.state = await this.magi.updateState(this.state.output, {
      pr: { checks },
      text: `Finished checking CI for ${this.getLink()}.`,
    })
  }

  public async checkExistingReviews() {
    this.context.abort.throwIfAborted()

    this.state = await this.magi.updateState(this.state.output, {
      text: `Fetching existing reviews for ${this.getLink()}.`,
    })

    if (!this.state.pr?.metadata)
      throw new MagiError("blocked", "PR metadata not found.")
    if (!this.config.review.reviewers?.length)
      throw new MagiError("blocked", "No reviewers configured.")

    const [reviews, commits] = await Promise.all([
      this.getReviews(),
      this.getCommits(),
    ])
    this.state = await this.magi.updateState(this.state.output, {
      pr: { commits, reviews },
    })
    const latestNonMergeCommit = commits
      .toReversed()
      .find(({ parents }) => parents.length < 2)
    const reviewers: { [key: string]: ReviewerState } = Object.fromEntries(
      this.config.review.reviewers.map(({ account, id }) => {
        const targetReviews = reviews.filter(
          ({ state, user }) => state !== "DISMISSED" && user!.login === account,
        )

        if (!targetReviews.length) {
          return [id, { account, status: "initial" }]
        } else {
          const latestReviews = targetReviews.filter(
            ({ submitted_at }) =>
              latestNonMergeCommit?.commit.author?.date &&
              submitted_at &&
              submitted_at.localeCompare(
                latestNonMergeCommit.commit.author.date,
              ) >= 0,
          )
          const review = targetReviews.at(-1)

          if (latestReviews.length) {
            return [id, { account, review, status: "skip" }]
          } else {
            return [id, { account, review, status: "rereview" }]
          }
        }
      }),
    )
    const skip = Object.values(reviewers).every(
      ({ status }) => status === "skip",
    )

    this.state = await this.magi.updateState(this.state.output, {
      reviewers,
      text: `Finished fetching existing reviews for ${this.getLink()}.`,
    })

    if (skip)
      throw new MagiError(
        "blocked",
        "PR has already been reviewed by all configured accounts.",
      )
  }

  public async fetchReviewContext() {
    this.context.abort.throwIfAborted()

    this.state = await this.magi.updateState(this.state.output, {
      text: `Fetching review context for ${this.getLink()}.`,
    })

    const [comments, conflicts, issues, threads] = await Promise.all([
      this.getComments(),
      this.getConflicts(),
      this.getClosingIssues(),
      this.getReviewThreads(),
    ])
    const inlineCommentTargets = await this.getInlineCommentTargets(!!conflicts)

    this.state = await this.magi.updateState(this.state.output, {
      pr: { comments, conflicts, inlineCommentTargets, issues, threads },
      text: `Finished fetching review context for ${this.getLink()}.`,
    })
  }

  public async createSessions() {
    this.context.abort.throwIfAborted()

    if (!this.config.review.reviewers?.length)
      throw new MagiError("blocked", "No reviewers configured.")

    const reviewers = Object.fromEntries(
      await Promise.all(
        this.config.review.reviewers.map(
          async ({ account, id, model, permissions }) =>
            [
              id,
              {
                account,
                sessionId: await this.magi.createSession(
                  this.state.sessionId,
                  `magi review #${this.number} reviewer ${id}`,
                  { model, permissions },
                ),
              },
            ] as const,
        ),
      ),
    )
    const { id, model, permissions } = this.config.review.reporter
      ? this.config.review.reviewers.find(
          ({ id }) => id === this.config.review.reporter,
        )!
      : this.config.review.reviewers[
          Math.abs(this.number) % this.config.review.reviewers.length
        ]!
    const reporter =
      this.config.mode === "single"
        ? {
            account: this.config.account,
            sessionId: await this.magi.createSession(
              this.state.sessionId,
              `magi review #${this.number} reporter ${id}`,
              { model, permissions },
            ),
          }
        : undefined

    this.state = await this.magi.updateState(this.state.output, {
      reporter,
      reviewers,
    })

    return reviewers
  }

  public async createWorktree() {
    this.context.abort.throwIfAborted()

    this.state = await this.magi.updateState(this.state.output, {
      text: `Creating worktree for ${this.getLink()}.`,
    })

    const worktree = await this.magi.createWorktree(
      this.config.review.worktree,
      this.number,
      this.state.id,
      this.context.abort,
    )

    this.state = await this.magi.updateState(this.state.output, {
      text: `Finished creating worktree for ${this.getLink()}.`,
      worktree,
    })
  }

  public async classifyChecks() {
    this.context.abort.throwIfAborted()

    if (!this.state.pr?.checks?.failed.length) return

    if (!this.state.pr.metadata)
      throw new MagiError("blocked", "PR metadata not found.")
    if (!this.state.worktree)
      throw new MagiError("blocked", "PR worktree not found.")

    await this.magi.updateState(this.state.output, {
      text: `Classifying CI checks for ${this.getLink()}.`,
    })

    const worker = new Worker(this.config.review.concurrency.reviewers)
    const classifiedChecks: { [key: string]: PullRequestClassifiedChecks } =
      Object.fromEntries(this.state.pr.checks.failed.map(({ id }) => [id, {}]))
    const prompt = await Prompt.init(
      this.magi,
      this.config,
      "review/ci-classification",
    )

    const taskMessage = await prompt.create(
      this.config.review.prompts?.ciClassification,
      ["output_contract"],
      {
        baseSha: this.state.pr.metadata.base.sha,
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

  public async rerunChecks() {
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
              .map(async ({ id }) => this.rerunCheck(id)),
          )
          await this.watchChecks()

          const { failed, passed } = await this.getChecks()

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

    await this.magi.updateState(this.state.output, {
      pr: { checks },
      text: `Finished rerunning checks for ${this.getLink()}.`,
    })
  }

  public async review() {
    this.context.abort.throwIfAborted()

    if (!this.config.review.reviewers?.length)
      throw new MagiError("blocked", "No reviewers configured.")

    this.state = await this.magi.updateState(this.state.output, {
      text: `Reviewing ${this.getLink()}.`,
    })

    const worker = new Worker<[string, ReviewerState]>(
      this.config.review.concurrency.reviewers,
    )
    const reviewers = Object.fromEntries(
      await Promise.all(
        this.config.review.reviewers.map(({ account, id, persona }) =>
          worker.run(async () => {
            if (!this.state.pr?.metadata)
              throw new MagiError("blocked", "PR metadata not found.")
            if (!this.state.worktree)
              throw new MagiError("blocked", "PR worktree not found.")
            if (!this.state.pr.checks)
              throw new MagiError("blocked", "PR checks not found.")
            if (!this.state.pr.threads)
              throw new MagiError("blocked", "PR threads not found.")
            if (!this.state.reviewers)
              throw new MagiError("blocked", "Reviewers not found.")

            const { review, sessionId, status } = this.state.reviewers[id]!

            if (status === "skip") {
              if (!review)
                throw new MagiError(
                  "blocked",
                  `No review found for reviewer ${id}.`,
                )

              const verdict =
                review.state === "APPROVED"
                  ? "MERGE"
                  : review.state === "CHANGES_REQUESTED"
                    ? "CHANGES_REQUESTED"
                    : "CLOSE"

              this.magi.notify(
                this.state.sessionId,
                `Skipping review for ${this.getLink()} with reviewer ${id}.`,
              )

              return [id, { output: { verdict } }]
            } else {
              if (!sessionId)
                throw new MagiError(
                  "blocked",
                  `No session ID found for reviewer ${id}.`,
                )
              if (status === "rereview" && !review?.commit_id)
                throw new MagiError(
                  "blocked",
                  `Missing previous review commit for reviewer ${id}.`,
                )

              const label = `${status === "rereview" ? "re" : ""}review`

              await this.magi.notify(
                this.state.sessionId,
                `Running ${label} for ${this.getLink()} with reviewer ${id}.`,
              )

              const sha =
                status === "initial"
                  ? this.state.pr.metadata.base.sha
                  : review!.commit_id!
              const inlineCommentTargets =
                this.state.pr.inlineCommentTargets?.[sha] ?? {}
              const failedChecks = this.state.pr.checks.failed.filter(
                ({ scope }) => scope,
              )
              const unresolvedThreads = this.state.pr.threads.filter(
                ({ comments, isResolved }) =>
                  !isResolved &&
                  (!account ||
                    comments.some(({ author }) => author?.login === account)),
              )
              const reviewContext = JSON.stringify(
                omitNullish({
                  checks: this.state.pr.checks,
                  comments: this.state.pr.comments,
                  files: this.state.pr.files,
                  issues: this.state.pr.issues,
                  metadata: this.state.pr.metadata,
                  threads: this.state.pr.threads,
                }),
                null,
                2,
              )
              const tags: PromptTag[] = [
                "output_contract",
                ["review", reviewContext],
              ]

              if (review) {
                const previousReviewContext = JSON.stringify(
                  omitNullish({
                    body: review.body,
                    commitId: review.commit_id,
                    state: review.state,
                    submittedAt: review.submitted_at,
                  }),
                  null,
                  2,
                )

                tags.push(["previous_review", previousReviewContext])
              }

              if (unresolvedThreads.length) {
                const unresolvedThreadsContext = JSON.stringify(
                  unresolvedThreads,
                  null,
                  2,
                )

                tags.push(["unresolved_threads", unresolvedThreadsContext])
              }

              if (this.state.pr.conflicts) {
                const mergeConflictContext = JSON.stringify(
                  this.state.pr.conflicts,
                  null,
                  2,
                )

                tags.push(["merge_conflict", mergeConflictContext])
              }

              if (failedChecks.length) {
                const ciFailureContext = JSON.stringify(failedChecks, null, 2)

                tags.push(["ci_failure", ciFailureContext])
              }

              if (persona) tags.push(["persona", persona])

              const prompt = await Prompt.init(
                this.magi,
                this.config,
                `review/${status === "rereview" ? "rereview" : "review"}`,
              )
              const taskMessage = await prompt.create(
                status === "rereview"
                  ? this.config.review.prompts?.rereview
                  : this.config.review.prompts?.review,
                tags,
                omitNullish({
                  baseSha: this.state.pr.metadata.base.sha,
                  headSha: this.state.pr.metadata.head.sha,
                  owner: this.config.github.owner,
                  pr: this.number.toString(),
                  previousHeadSha: review?.commit_id,
                  repo: this.config.github.repo,
                  worktreePath: this.state.worktree.path,
                }),
              )
              const repairMessage = await prompt.repair()

              const output = await retry<ReviewOutput>(
                async (count) => {
                  const raw = await this.magi.promptSession(
                    sessionId,
                    count === 1 ? taskMessage : repairMessage,
                  )
                  const parsed = prompt.parse(raw)

                  if (!prompt.validate<ReviewOutput>(parsed))
                    throw new Error(`Invalid output for reviewer ${id}.`)

                  this.validateInlineCommentTargets(
                    status,
                    parsed,
                    inlineCommentTargets,
                  )

                  return parsed
                },
                {
                  error: (_, count) =>
                    this.magi.notify(
                      this.state.sessionId,
                      `Attempt ${count} failed to ${label} for ${this.getLink()} with reviewer ${id}. Retrying...`,
                    ),
                  retries: this.config.output.repairAttempts,
                },
              )

              if (!output)
                throw new MagiError(
                  "blocked",
                  `Invalid output for reviewer ${id}.`,
                )

              return [id, { output }]
            }
          }),
        ),
      ),
    )

    this.state = await this.magi.updateState(this.state.output, {
      reviewers,
      text: `Finished reviewing ${this.getLink()}.`,
    })
  }

  public async validateFindings() {
    this.context.abort.throwIfAborted()

    if (!this.config.review.reviewers?.length)
      throw new MagiError("blocked", "No reviewers configured.")
    if (!this.state.reviewers)
      throw new MagiError("blocked", "Reviewers not found.")

    const targets = Object.entries(this.state.reviewers).flatMap(
      ([reviewer, { output }]) => {
        if (output?.verdict !== "CHANGES_REQUESTED") return []

        return (output.findings ?? output.newFindings ?? []).map(
          (finding, findingIndex) => ({
            finding,
            findingIndex,
            reviewer,
          }),
        )
      },
    )

    if (!targets.length) return

    this.state = await this.magi.updateState(this.state.output, {
      text: `Validating review findings for ${this.getLink()}.`,
    })

    const worker = new Worker<[string, FindingValidationOutput]>(
      this.config.review.concurrency.reviewers,
    )
    const prompt = await Prompt.init(
      this.magi,
      this.config,
      "review/finding-validation",
    )
    const validations = Object.fromEntries(
      await Promise.all(
        this.config.review.reviewers.map(({ id }) =>
          worker.run(async () => {
            const { sessionId } = this.state.reviewers![id]!

            if (!sessionId)
              throw new MagiError(
                "blocked",
                `No session ID found for reviewer ${id}.`,
              )

            await this.magi.notify(
              this.state.sessionId,
              `Validating review findings for ${this.getLink()} with reviewer ${id}.`,
            )

            const reviewTargets = targets.filter(
              (target) => target.reviewer !== id,
            )
            const taskMessage = await prompt.create(
              this.config.review.prompts?.findingValidation,
              ["output_contract"],
              {
                findings: JSON.stringify(reviewTargets, null, 2),
                owner: this.config.github.owner,
                pr: this.number.toString(),
                repo: this.config.github.repo,
              },
            )
            const repairMessage = await prompt.repair()

            const output = await retry<FindingValidationOutput>(
              async (count) => {
                const raw = await this.magi.promptSession(
                  sessionId,
                  count === 1 ? taskMessage : repairMessage,
                )
                const parsed = prompt.parse(raw)

                if (!prompt.validate<FindingValidationOutput>(parsed))
                  throw new Error(
                    `Invalid finding validation output for reviewer ${id}.`,
                  )

                const expected = targets.filter(
                  ({ reviewer }) => reviewer !== id,
                )
                const expectedKeys = new Set(
                  expected.map(
                    ({ findingIndex, reviewer }) =>
                      `${reviewer}:${findingIndex}`,
                  ),
                )
                const seen = new Set<string>()

                for (const vote of parsed.votes) {
                  if (vote.reviewer === id)
                    throw new Error(`${id} must not vote on its own findings.`)

                  const key = `${vote.reviewer}:${vote.findingIndex}`

                  if (!expectedKeys.has(key))
                    throw new Error(`Unexpected finding vote: ${key}.`)
                  if (seen.has(key))
                    throw new Error(`Duplicate finding vote: ${key}.`)

                  seen.add(key)
                }

                for (const target of expected) {
                  const key = `${target.reviewer}:${target.findingIndex}`

                  if (!seen.has(key))
                    throw new Error(`Missing finding vote: ${key}.`)
                }

                return parsed
              },
              {
                error: (_, count) =>
                  this.magi.notify(
                    this.state.sessionId,
                    `Attempt ${count} failed to validate review findings for ${this.getLink()} with reviewer ${id}. Retrying...`,
                  ),
                retries: this.config.output.repairAttempts,
              },
            )

            if (!output)
              throw new MagiError(
                "blocked",
                `Invalid finding validation output for reviewer ${id}.`,
              )

            return [id, output]
          }),
        ),
      ),
    )
    const threshold = Math.floor(this.config.review.reviewers.length / 2) + 1

    await Promise.all(
      targets.map(async ({ finding, findingIndex, reviewer }) => {
        const votes = Object.entries(validations).flatMap(
          ([validator, validation]) => {
            if (validator === reviewer) return []

            const vote = validation.votes.find(
              (vote) =>
                vote.reviewer === reviewer &&
                vote.findingIndex === findingIndex,
            )

            return vote ? [{ validator, vote }] : []
          },
        )
        const agrees =
          1 + votes.filter(({ vote }) => vote.vote === "AGREE").length
        const accepted = agrees >= threshold
        const acceptedComments = votes
          .filter(({ vote }) => vote.vote === "AGREE")
          .map(({ validator, vote }) => `- ${validator}: ${vote.comment}`)
        const rejectedComments = votes
          .filter(({ vote }) => vote.vote === "DISAGREE")
          .map(({ validator, vote }) => `- ${validator}: ${vote.comment}`)

        await this.magi.notify(
          this.state.sessionId,
          filterEmpty([
            `Finding ${reviewer} #${findingIndex + 1} for ${this.getLink()} was ${accepted ? "accepted" : "rejected"} by majority vote.`,
            `Finding: ${finding.path}:${finding.line}\n${finding.body}`,
            acceptedComments.length
              ? `Accepted by:\n${acceptedComments.join("\n")}`
              : undefined,
            rejectedComments.length
              ? `Rejected by:\n${rejectedComments.join("\n")}`
              : undefined,
          ]).join("\n\n"),
        )
      }),
    )

    const reviewers = Object.fromEntries(
      Object.entries(this.state.reviewers ?? {}).map(([id, reviewer]) => {
        const output = reviewer.output

        if (output?.verdict !== "CHANGES_REQUESTED") return [id, { output }]

        const keptIndexes = new Set<number>()
        const findings = output.findings ?? output.newFindings ?? []

        findings.forEach((_finding, findingIndex) => {
          let agrees = 1

          for (const [validator, validation] of Object.entries(validations)) {
            if (validator === id) continue

            const vote = validation.votes.find(
              (vote) =>
                vote.reviewer === id && vote.findingIndex === findingIndex,
            )

            if (vote?.vote === "AGREE") agrees += 1
          }

          if (agrees >= threshold) keptIndexes.add(findingIndex)
        })

        if (output.findings) {
          const findings = output.findings.filter((_finding, index) =>
            keptIndexes.has(index),
          )
          const newOutput = findings.length
            ? { ...output, findings }
            : { ...output, findings: [], verdict: "MERGE" }

          return [id, { output: newOutput }]
        } else {
          const newFindings = output.newFindings?.filter((_finding, index) =>
            keptIndexes.has(index),
          )
          const newOutput =
            newFindings?.length || output.followUps?.length
              ? { ...output, newFindings }
              : { ...output, newFindings: [], verdict: "MERGE" }

          return [id, { output: newOutput }]
        }
      }),
    )

    this.state = await this.magi.updateState(this.state.output, {
      reviewers,
      text: `Finished validating review findings for ${this.getLink()}.`,
    })
  }

  public async reconsiderClose() {
    this.context.abort.throwIfAborted()

    if (this.config.review.merge.approvalPolicy !== "unanimous") return

    if (!this.config.review.reviewers?.length)
      throw new MagiError("blocked", "No reviewers configured.")
    if (!this.state.reviewers)
      throw new MagiError("blocked", "Reviewers not found.")

    const threshold = Math.floor(this.config.review.reviewers.length / 2) + 1
    const targetReviewers = Object.entries(this.state.reviewers).filter(
      ([, { output }]) => output?.verdict === "CLOSE",
    )
    const count = targetReviewers.length

    if (!count || count >= threshold) return

    this.state = await this.magi.updateState(this.state.output, {
      text: `Reconsidering close verdicts for ${this.getLink()}.`,
    })

    const worker = new Worker<[string, ReviewerState]>(
      this.config.review.concurrency.reviewers,
    )
    const prompt = await Prompt.init(
      this.magi,
      this.config,
      "review/close-reconsideration",
    )
    const reviewers = Object.fromEntries(
      await Promise.all(
        targetReviewers.map(([id, { review, sessionId, status }]) =>
          worker.run(async () => {
            if (!this.state.pr?.metadata)
              throw new MagiError("blocked", "PR metadata not found.")
            if (!sessionId)
              throw new MagiError(
                "blocked",
                `No session ID found for reviewer ${id}.`,
              )
            if (status === "rereview" && !review?.commit_id)
              throw new MagiError(
                "blocked",
                `Missing previous review commit for reviewer ${id}.`,
              )

            const sha =
              status === "initial"
                ? this.state.pr.metadata.base.sha
                : review!.commit_id!
            const inlineCommentTargets =
              this.state.pr.inlineCommentTargets?.[sha] ?? {}

            const taskMessage = await prompt.create(
              this.config.review.prompts?.closeReconsideration,
              ["output_contract"],
              {
                owner: this.config.github.owner,
                pr: this.number.toString(),
                repo: this.config.github.repo,
              },
            )
            const repairMessage = await prompt.repair()

            await this.magi.notify(
              this.state.sessionId,
              `Reconsidering close verdict for ${this.getLink()} with reviewer ${id}.`,
            )

            const output = await retry<ReviewOutput>(
              async (count) => {
                const raw = await this.magi.promptSession(
                  sessionId,
                  count === 1 ? taskMessage : repairMessage,
                )
                const parsed = prompt.parse(raw)

                if (!prompt.validate<ReviewOutput>(parsed))
                  throw new Error(
                    `Invalid close reconsideration output for reviewer ${id}.`,
                  )

                this.validateInlineCommentTargets(
                  "initial",
                  parsed,
                  inlineCommentTargets,
                )

                return parsed
              },
              {
                error: (_, count) =>
                  this.magi.notify(
                    this.state.sessionId,
                    `Attempt ${count} failed to reconsider close verdict for ${this.getLink()} with reviewer ${id}. Retrying...`,
                  ),
                retries: this.config.output.repairAttempts,
              },
            )

            if (!output)
              throw new MagiError(
                "blocked",
                `Invalid close reconsideration output for reviewer ${id}.`,
              )

            return [
              id,
              {
                output: {
                  comment: output.comment,
                  findings: output.findings,
                  followUps: undefined,
                  newFindings: undefined,
                  resolves: undefined,
                  verdict: output.verdict,
                },
              },
            ]
          }),
        ),
      ),
    )

    this.state = await this.magi.updateState(this.state.output, {
      reviewers,
      text: `Finished reconsidering close verdicts for ${this.getLink()}.`,
    })
  }

  public async resolveVerdict() {
    if (!this.config.review.reviewers?.length)
      throw new MagiError("blocked", "No reviewers configured.")
    if (!this.state.reviewers)
      throw new MagiError("blocked", "Reviewers not found.")

    const counts = { CHANGES_REQUESTED: 0, CLOSE: 0, MERGE: 0 }
    const length = this.config.review.reviewers.length
    const threshold = Math.floor(length / 2) + 1

    for (const [id, { output }] of Object.entries(this.state.reviewers)) {
      if (!output)
        throw new MagiError("blocked", `No output found for reviewer ${id}.`)

      counts[output.verdict] += 1
    }

    const majority = this.config.review.merge.approvalPolicy === "majority"
    const verdict =
      counts.CLOSE >= threshold
        ? "CLOSE"
        : (!majority && counts.MERGE === length) ||
            (majority && counts.MERGE >= threshold)
          ? "MERGE"
          : "CHANGES_REQUESTED"

    this.state = await this.magi.updateState(this.state.output, {
      pr: { verdict },
      text: `Final verdict for ${this.getLink()} is ${verdict}.`,
    })
  }

  public async postReviews() {
    this.context.abort.throwIfAborted()

    if (this.state.dryRun) return

    if (!this.config.review.reviewers?.length)
      throw new MagiError("blocked", "No reviewers configured.")
    if (!this.state.reviewers)
      throw new MagiError("blocked", "Reviewers not found.")

    const args = {
      owner: this.config.github.owner,
      pull_number: this.number,
      repo: this.config.github.repo,
    }

    this.state = await this.magi.updateState(this.state.output, {
      text: `Posting reviews for ${this.getLink()}.`,
    })

    if (this.config.mode === "single") {
      if (!this.state.pr?.verdict)
        throw new MagiError("blocked", "PR verdict not found.")

      const octokit = await this.magi.createOctokit(
        this.config,
        this.context.abort,
        this.config.account,
      )
      const graphql = this.magi.createGraphql(octokit)

      await Promise.all(
        Object.values(this.state.reviewers!).flatMap(({ output }) =>
          (output?.resolves ?? []).map(({ threadId }) =>
            graphql.resolveReviewThread({ threadId }),
          ),
        ),
      )
      await Promise.all(
        Object.entries(this.state.reviewers!).flatMap(([_id, { output }]) =>
          (output?.followUps ?? []).map(({ body, commentId }) =>
            octokit.rest.pulls.createReplyForReviewComment({
              ...args,
              body,
              comment_id: commentId,
            }),
          ),
        ),
      )

      let posted: string

      switch (this.state.pr.verdict) {
        case "MERGE": {
          const { data } = await octokit.rest.pulls.createReview({
            ...args,
            event: "APPROVE",
          })

          posted = data.html_url

          break
        }
        case "CLOSE": {
          const { data } = await octokit.rest.pulls.createReview({
            ...args,
            body: "",
            event: "COMMENT",
          })

          posted = data.html_url

          break
        }
        case "CHANGES_REQUESTED": {
          const comments = Object.entries(this.state.reviewers!).flatMap(
            ([_id, { output }]) =>
              (output?.findings ?? output?.newFindings ?? []).map(
                ({ startLine, ...rest }) => ({
                  ...rest,
                  ...(startLine == null
                    ? {}
                    : { start_line: startLine, start_side: "RIGHT" }),
                }),
              ),
          )

          const { data } = await octokit.rest.pulls.createReview({
            ...args,
            body: "",
            comments,
            event: "REQUEST_CHANGES",
          })

          posted = data.html_url

          break
        }
      }

      this.state = await this.magi.updateState(this.state.output, {
        reviewers: Object.fromEntries(
          Object.keys(this.state.reviewers!).map((id) => [id, { posted }]),
        ),
        text: `Finished posting reviews for ${this.getLink()}.`,
      })
    } else {
      const worker = new Worker<[string, ReviewerState]>(
        this.config.review.concurrency.reviewers,
      )
      const reviewers = Object.fromEntries(
        await Promise.all(
          Object.entries(this.state.reviewers!).map(
            ([id, { account, output }]) =>
              worker.run(async () => {
                if (!output) return [id, {}]

                const octokit = await this.magi.createOctokit(
                  this.config,
                  this.context.abort,
                  account,
                )
                const graphql = this.magi.createGraphql(octokit)

                await Promise.all(
                  (output.resolves ?? []).map(({ threadId }) =>
                    graphql.resolveReviewThread({ threadId }),
                  ),
                )
                await Promise.all(
                  (output.followUps ?? []).map(async ({ body, commentId }) =>
                    octokit.rest.pulls.createReplyForReviewComment({
                      ...args,
                      body,
                      comment_id: commentId,
                    }),
                  ),
                )

                switch (output.verdict) {
                  case "MERGE": {
                    const { data } = await octokit.rest.pulls.createReview({
                      ...args,
                      event: "APPROVE",
                    })

                    return [id, { posted: data.html_url }]
                  }
                  case "CLOSE": {
                    const { data } = await octokit.rest.pulls.createReview({
                      ...args,
                      body: output.comment,
                      event: "COMMENT",
                    })

                    return [id, { posted: data.html_url }]
                  }
                  case "CHANGES_REQUESTED": {
                    const findings = output.findings ?? output.newFindings ?? []

                    if (!findings.length) return [id, {}]

                    const comments = findings.map(({ startLine, ...rest }) => ({
                      ...rest,
                      ...(startLine == null
                        ? {}
                        : { start_line: startLine, start_side: "RIGHT" }),
                    }))
                    const { data } = await octokit.rest.pulls.createReview({
                      ...args,
                      body: output.comment,
                      comments,
                      event: "REQUEST_CHANGES",
                    })

                    return [id, { posted: data.html_url }]
                  }
                }
              }),
          ),
        ),
      )

      this.state = await this.magi.updateState(this.state.output, {
        reviewers,
        text: `Finished posting reviews for ${this.getLink()}.`,
      })
    }
  }

  public async createReport(e?: unknown) {
    if (!e) {
      return this.magi.updateState(this.state.output, {
        completedAt: new Date().toISOString(),
        status: "completed",
        text: `Finished reviewing ${this.getLink()}.`,
      })
    } else {
      const error = e instanceof Error ? e.message : "Unknown error"
      const status =
        e instanceof MagiError
          ? e.status
          : this.context.abort.aborted
            ? "cancelled"
            : "failed"

      return this.magi.updateState(this.state.output, {
        completedAt: new Date().toISOString(),
        error,
        status,
        text: `${toTitleCase(status)} reviewing ${this.getLink()}: ${error}`,
      })
    }
  }

  private async getMetadata() {
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

  private async getComments() {
    return await this.octokit.paginate(this.octokit.rest.issues.listComments, {
      issue_number: this.number,
      owner: this.config.github.owner,
      repo: this.config.github.repo,
    })
  }

  private async getClosingIssues() {
    const data = await this.graphql.paginate(this.graphql.closingIssues, {
      owner: this.config.github.owner,
      pr: this.number,
      repo: this.config.github.repo,
    })

    return filterEmpty(
      data.repository?.pullRequest?.closingIssuesReferences?.nodes?.map(
        (node) =>
          node && { ...node, comments: filterEmpty(node.comments.nodes ?? []) },
      ) ?? [],
    )
  }

  private async getReviewThreads() {
    const data = await this.graphql.paginate(this.graphql.reviewThreads, {
      owner: this.config.github.owner,
      pr: this.number,
      repo: this.config.github.repo,
    })

    return filterEmpty(
      data.repository?.pullRequest?.reviewThreads.nodes?.map(
        (node) =>
          node && { ...node, comments: filterEmpty(node.comments.nodes ?? []) },
      ) ?? [],
    )
  }

  private async getReviews() {
    return await this.octokit.paginate(this.octokit.rest.pulls.listReviews, {
      owner: this.config.github.owner,
      pull_number: this.number,
      repo: this.config.github.repo,
    })
  }

  private async getCommits() {
    return await this.octokit.paginate(this.octokit.rest.pulls.listCommits, {
      owner: this.config.github.owner,
      pull_number: this.number,
      repo: this.config.github.repo,
    })
  }

  private async getInlineCommentTargets(conflict: boolean = false) {
    if (!this.state.reviewers)
      throw new MagiError("blocked", "Reviewers not found.")
    if (!this.state.pr?.metadata)
      throw new MagiError("blocked", "PR metadata not found.")
    if (!this.state.worktree)
      throw new MagiError("blocked", "PR worktree not found.")

    const get = async (from: [string, string], to: [string, string]) => {
      const inlineCommentTargets: { [key: string]: number[] } = {}
      const [fromSource, fromSha] = from
      const [toSource, toSha] = to
      const commits = [
        { label: "from", sha: fromSha, source: fromSource },
        { label: "to", sha: toSha, source: toSource },
      ]
      const missing = filterEmpty(
        await Promise.all(
          commits.map(async (commit) => {
            if (!(await this.hasCommit(commit.sha))) return commit
          }),
        ),
      )
      const sources = new Set(missing.map(({ source }) => source))

      for (const source of sources) {
        const ref =
          source === "base"
            ? this.state.pr!.metadata!.base.ref
            : this.state.pr!.metadata!.head.ref
        const url =
          source === "base"
            ? this.state.pr!.metadata!.base.repo.clone_url
            : this.state.pr!.metadata!.head.repo.clone_url

        await this.exec(
          command(
            "git",
            "fetch",
            "--no-tags",
            quote(url),
            quote(`refs/heads/${ref}`),
          ),
          { cwd: this.state.worktree!.path, signal: this.context.abort },
        )
      }

      for (const commit of missing) {
        if (await this.hasCommit(commit.sha)) continue

        const ref =
          commit.source === "base"
            ? this.state.pr!.metadata!.base.ref
            : this.state.pr!.metadata!.head.ref

        throw new MagiError(
          "blocked",
          `${commit.label} commit ${commit.sha} is unavailable after fetching ${commit.source} ref ${ref}.`,
        )
      }

      const diff = await this.exec(
        command(
          "git",
          "diff",
          "--no-ext-diff",
          "--unified=3",
          quote(`${fromSha}...${toSha}`),
        ),
        { cwd: this.state.worktree!.path, signal: this.context.abort },
      )

      let path: string | undefined
      let line: number | undefined

      for (const entry of diff.split("\n")) {
        if (entry.startsWith("+++ ")) {
          let value = entry.slice(4)

          if (value === "/dev/null") continue

          if (value.startsWith('"') && value.endsWith('"')) {
            try {
              value = JSON.parse(value)
            } catch {
              value = value.slice(1, -1)
            }
          }

          path = value.startsWith("b/") ? value.slice(2) : value
          line = undefined

          continue
        }

        if (entry.startsWith("@@ ")) {
          const match = entry.match(/\+(\d+)(?:,\d+)?/)

          line = match ? Number(match[1]) : undefined

          continue
        }

        if (!path || line == null) continue

        if (entry.startsWith("+") || entry.startsWith(" ")) {
          const lines = inlineCommentTargets[path] ?? []

          lines.push(line)
          inlineCommentTargets[path] = lines

          line += 1
        }
      }

      return inlineCommentTargets
    }

    const baseSha = this.state.pr.metadata.base.sha
    const headSha = this.state.pr.metadata.head.sha
    const inlineCommentTargets: PullRequestInlineCommentTargets = {
      [baseSha]: await get(["base", baseSha], ["head", headSha]),
    }
    const reviewers = Object.entries(this.state.reviewers)

    for (const [id, { review, status }] of reviewers) {
      if (status !== "rereview") continue
      if (!review?.commit_id)
        throw new MagiError(
          "blocked",
          `Missing previous review commit for reviewer ${id}.`,
        )

      const previousHeadSha = review.commit_id

      if (!inlineCommentTargets[previousHeadSha]) {
        inlineCommentTargets[previousHeadSha] = await get(
          ["head", previousHeadSha],
          ["head", headSha],
        )
      }

      if (!conflict) continue

      inlineCommentTargets[previousHeadSha] = this.getMergeInlineCommentTargets(
        inlineCommentTargets[previousHeadSha],
        inlineCommentTargets[baseSha]!,
      )
    }

    return inlineCommentTargets
  }

  private async hasCommit(sha: string) {
    if (!this.state.worktree)
      throw new MagiError("blocked", "PR worktree not found.")

    try {
      await this.exec(
        command("git", "cat-file", "-e", quote(`${sha}^{commit}`)),
        {
          cwd: this.state.worktree.path,
          signal: this.context.abort,
        },
      )

      return true
    } catch {
      return false
    }
  }

  private getMergeInlineCommentTargets(
    left: { [key: string]: number[] },
    right: { [key: string]: number[] },
  ) {
    const inlineCommentTargets: { [key: string]: number[] } = {}

    for (const [path, lines] of [
      ...Object.entries(left),
      ...Object.entries(right),
    ]) {
      inlineCommentTargets[path] = filterDuplicates([
        ...(inlineCommentTargets[path] ?? []),
        ...lines,
      ])
    }

    return inlineCommentTargets
  }

  private validateInlineCommentTargets(
    status: string | undefined,
    output: ReviewOutput,
    inlineCommentTargets: { [key: string]: number[] },
  ) {
    const target = status === "rereview" ? "newFindings" : "findings"
    const findings = output[target] ?? []

    for (const [index, finding] of findings.entries()) {
      const name = `${target}[${index}]`

      if (!Number.isInteger(finding.line) || finding.line < 1)
        throw new Error(`${name}.line must be a positive integer.`)

      if (finding.startLine != null) {
        if (!Number.isInteger(finding.startLine) || finding.startLine < 1)
          throw new Error(`${name}.startLine must be a positive integer.`)

        if (finding.startLine > finding.line)
          throw new Error(
            `${name}.startLine must be before or equal to ${name}.line.`,
          )
      }

      const lines = inlineCommentTargets[finding.path]

      if (!lines) {
        throw new Error(
          `${name} targets ${finding.path}:${finding.line}, but path is not in the PR diff.`,
        )
      } else {
        const startLine = finding.startLine ?? finding.line

        for (let line = startLine; line <= finding.line; line++) {
          if (!lines.includes(line))
            throw new Error(
              `${name} targets ${finding.path}:${line}, but line is not in a right-side PR diff hunk.`,
            )
        }
      }
    }
  }

  private async getConflicts() {
    if (!this.state.pr?.metadata)
      throw new MagiError("blocked", "PR metadata not found.")
    if (!this.state.worktree)
      throw new MagiError("blocked", "PR worktree not found.")

    const mergeBaseSha = (
      await this.exec(
        command(
          "git",
          "merge-base",
          this.state.pr.metadata.base.sha,
          this.state.pr.metadata.head.sha,
        ),
        {
          cwd: this.state.worktree.path,
          signal: this.context.abort,
        },
      )
    ).trim()
    const output = (
      await this.exec(
        command(
          "git",
          "merge-tree",
          mergeBaseSha,
          this.state.pr.metadata.base.sha,
          this.state.pr.metadata.head.sha,
        ),
        {
          cwd: this.state.worktree.path,
          signal: this.context.abort,
        },
      )
    ).trim()
    const lines = output.split("\n")
    const conflicts = Object.fromEntries(
      lines
        .reduce<{ entries: [string, string[]][]; previous: string }>(
          (acc, line) => {
            const file = line.match(
              /^  (?:base|our|their)\s+\d+\s+[0-9a-f]+\s+(.+)$/,
            )?.[1]
            const entry = acc.entries.at(-1)

            if (file && entry?.[0] !== file) {
              acc.entries.push([
                file,
                acc.previous.trim() ? [acc.previous] : [],
              ])
            }

            acc.entries.at(-1)?.[1].push(line)
            acc.previous = line

            return acc
          },
          { entries: [], previous: "" },
        )
        .entries.map(([file, lines]) => [file, lines.join("\n").trim()]),
    )

    if (Object.keys(conflicts).length) return conflicts
  }

  private async getChecks() {
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
            const log = await this.getCheckLog(check.id)

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

  private async getCheckLog(id: string) {
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

  private async rerunCheck(id: string) {
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

  private async watchChecks() {
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
}
