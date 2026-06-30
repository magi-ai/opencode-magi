import type {
  PullRequestAutomation,
  PullRequestFinding,
  PullRequestReviewParams,
} from "./index.type"
import type { Review } from "./review"
import type { ReviewerState } from "@/magi"
import type { Dict } from "@/utils"
import { MagiError } from "@/magi"
import { Prompt } from "@/prompts"
import {
  command,
  filterEmpty,
  isArray,
  isObject,
  isString,
  loop,
  marker,
  omitNullish,
  quote,
  retry,
  wait,
  Worker,
} from "@/utils"

const events = {
  APPROVED: "APPROVE",
  CHANGES_REQUESTED: "REQUEST_CHANGES",
  CLOSED: "COMMENT",
} as const
const mergeWorker = new Worker<PullRequestAutomation | void>(1)

export async function postReviews(this: Review): Promise<void> {
  this.context.abort.throwIfAborted()

  if (this.state.dryRun) return

  this.state = await this.magi.updateState(this.state.output, {
    text: `Posting reviews for ${this.getLink()}.`,
  })

  if (!this.config.review.reviewers?.length)
    throw new MagiError("blocked", "No reviewers configured.")
  if (!this.state.reviewers)
    throw new MagiError("blocked", "Reviewers not found.")

  const args = {
    owner: this.config.github.owner,
    pull_number: this.number,
    repo: this.config.github.repo,
  }

  if (this.config.mode === "single") {
    if (!this.state.pr?.verdict)
      throw new MagiError("blocked", "PR verdict not found.")

    const octokit = await this.magi.createOctokit(
      this.config,
      this.context.abort,
      this.config.account,
    )
    const graphql = this.magi.createGraphql(octokit)
    const reviewers = Object.entries(this.state.reviewers).filter(
      ([, { status }]) => status !== "skip",
    )

    await Promise.all(
      reviewers.flatMap(([, { outputs }]) =>
        (outputs?.at(-1)?.resolves ?? []).map(({ threadId }) =>
          graphql.resolveReviewThread({ threadId }),
        ),
      ),
    )
    await Promise.all(
      reviewers.flatMap(([, { outputs }]) =>
        (outputs?.at(-1)?.followUps ?? []).map(({ body, commentId }) =>
          octokit.rest.pulls.createReplyForReviewComment({
            ...args,
            body,
            comment_id: commentId,
          }),
        ),
      ),
    )

    const event = events[this.state.pr.verdict]
    const params: PullRequestReviewParams = { ...args, event }

    if (this.state.pr.verdict === "CHANGES_REQUESTED") {
      const findings = reviewers.flatMap(([id, { outputs }]) => {
        const output = outputs?.at(-1)

        return (output?.findings ?? output?.newFindings ?? [])
          .filter(({ state }) => state === "accepted")
          .map((finding) => ({ ...finding, id }))
      })

      if (!findings.length) {
        await this.notify(`Finished posting reviews for ${this.getLink()}.`)

        return
      }

      params.comments = findings.map(({ body, id, line, path, startLine }) => ({
        body: [
          body,
          marker.stringify({ command: "review", reviewer: id }),
        ].join("\n\n"),
        line,
        path,
        ...(startLine == null
          ? {}
          : { start_line: startLine, start_side: "RIGHT" }),
      }))
    }

    if (this.state.pr.verdict !== "APPROVED") {
      if (!this.state.operator?.sessionId)
        throw new MagiError("blocked", "Reporter session ID not found.")

      await this.notify(`Generating comment for ${this.getLink()} by operator.`)

      const contents = JSON.stringify(
        reviewers.flatMap<PullRequestFinding | string>(([, { outputs }]) => {
          const output = outputs?.at(-1)

          if (!output || output.verdict === "APPROVED") return []

          if (output.verdict === "CLOSED") return [output.comment!]
          else
            return (output.findings ?? output.newFindings ?? []).filter(
              ({ state }) => state === "accepted",
            )
        }),
        null,
        2,
      )
      const prompt = await Prompt.init(this.magi, this.config, "review/comment")
      const taskMessage = await prompt.create(
        undefined,
        ["output_contract", ["contents", contents]],
        {
          owner: this.config.github.owner,
          pr: this.number.toString(),
          repo: this.config.github.repo,
          verdict: this.state.pr.verdict,
        },
      )
      const repairMessage = await prompt.repair()
      const output = await retry(
        async (count) => {
          const raw = await this.magi.promptSession(
            this.state.operator!.sessionId!,
            count === 1 ? taskMessage : repairMessage,
          )
          const parsed = prompt.parse(raw)

          if (!prompt.validate<{ comment: string }>(parsed))
            throw new Error("Invalid output for operator.")

          return parsed.comment
        },
        {
          error: (_, count) =>
            this.notify(
              `Attempt ${count} failed to post comment for ${this.getLink()} by operator. Retrying...`,
            ),
          retries: this.config.output.repairAttempts,
        },
      )

      if (!output)
        throw new MagiError("blocked", "Invalid output for operator.")

      await this.notify(`Generated comment for ${this.getLink()} by operator.`)

      params.body = output
    }

    params.body = [
      params.body ?? "",
      marker.stringify(
        ...filterEmpty(
          reviewers.map(([id, { outputs }]) => {
            const output = outputs?.at(-1)

            if (!output) return

            const body = output.comment
              ? encodeURIComponent(output.comment)
              : undefined

            return omitNullish({
              body,
              command: "review",
              reviewer: id,
              verdict: output.verdict,
            })
          }),
        ),
      ),
    ].join("\n\n")

    const { data } = await octokit.rest.pulls.createReview(params)
    const posted = data.html_url

    this.state = await this.magi.updateState(this.state.output, {
      reviewers: Object.fromEntries(
        Object.keys(this.state.reviewers).map((id) => [id, { posted }]),
      ),
      text: `Finished posting reviews for ${this.getLink()}.`,
    })
  } else {
    const worker = new Worker<[string, ReviewerState]>(
      this.config.review.concurrency.reviewers,
    )
    const reviewers = Object.fromEntries(
      await Promise.all(
        Object.entries(this.state.reviewers).map(
          ([id, { account, outputs, review, status }]) =>
            worker.run(async () => {
              if (status === "skip") return [id, { posted: review?.html_url }]

              const output = outputs?.at(-1)

              if (!output)
                throw new MagiError("blocked", "Reviewer output not found.")

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
                (output.followUps ?? []).map(({ body, commentId }) =>
                  octokit.rest.pulls.createReplyForReviewComment({
                    ...args,
                    body,
                    comment_id: commentId,
                  }),
                ),
              )

              const event = events[output.verdict]
              const params: PullRequestReviewParams = { ...args, event }

              if (output.verdict !== "APPROVED") params.body = output.comment

              if (output.verdict === "CHANGES_REQUESTED") {
                const findings = (
                  output.findings ??
                  output.newFindings ??
                  []
                ).filter(({ state }) => state === "accepted")

                if (!findings.length) return [id, {}]

                params.comments = findings.map(
                  ({ body, line, path, startLine }) => ({
                    body,
                    line,
                    path,
                    ...(startLine == null
                      ? {}
                      : { start_line: startLine, start_side: "RIGHT" }),
                  }),
                )
              }

              params.body = [
                params.body ?? "",
                marker.stringify({
                  command: "review",
                  reviewer: id,
                  verdict: output.verdict,
                }),
              ].join("\n\n")

              const { data } = await octokit.rest.pulls.createReview(params)

              return [id, { posted: data.html_url }]
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

export async function automate(this: Review): Promise<PullRequestAutomation> {
  this.context.abort.throwIfAborted()

  if (!this.state.pr?.metadata)
    throw new MagiError("blocked", "PR metadata not found.")
  if (!this.state.pr.verdict)
    throw new MagiError("blocked", "PR verdict not found.")

  if (!["APPROVED", "CLOSED"].includes(this.state.pr.verdict)) return "SKIPPED"

  const automation = this.config[this.state.command].automation
  const action = this.state.pr.verdict === "APPROVED" ? "merge" : "close"

  if (!automation[action]) {
    this.state = await this.magi.updateState(this.state.output, {
      pr: { automation: "SKIPPED" },
      text: `Skipped ${action} automation for ${this.getLink()}.`,
    })

    return "SKIPPED"
  }

  const account = this.state.operator!.account!

  if (action === "merge") {
    if (!this.state.pr.checks)
      throw new MagiError("blocked", "PR checks not found.")

    const failed = this.state.pr.checks.failed
    const pending = this.state.pr.checks.pending

    if (failed.length || pending.length) {
      this.state = await this.magi.updateState(this.state.output, {
        pr: { automation: "SKIPPED" },
        text: `Skipped merge automation for ${this.getLink()} because unresolved CI checks remain.`,
      })

      return "SKIPPED"
    }

    if (await isConflict.call(this)) {
      this.state = await this.magi.updateState(this.state.output, {
        pr: { automation: "CONFLICT" },
        text: `Merge automation found conflicts for ${this.getLink()}.`,
      })

      return "CONFLICT"
    }
  }

  if (this.state.dryRun) {
    this.state = await this.magi.updateState(this.state.output, {
      pr: { automation: "SKIPPED" },
      text: `Skipped ${action} automation for ${this.getLink()} during dry run.`,
    })

    return "SKIPPED"
  }

  const token = await this.magi.getGhToken(account)

  if (action === "merge" && !this.config.review.merge.queue) {
    const rules = JSON.parse(
      await this.exec(
        command(
          "gh",
          "api",
          quote(
            `repos/${this.config.github.owner}/${this.config.github.repo}/rules/branches/${this.state.pr.metadata.base.ref}`,
          ),
        ),
        {
          env: { GH_TOKEN: token },
          signal: this.context.abort,
        },
      ),
    )

    if (isArray(rules)) {
      const enabledMergeQueue = rules.some(
        (rule) =>
          !!rule &&
          isObject(rule) &&
          "type" in rule &&
          rule.type === "merge_queue",
      )

      if (enabledMergeQueue)
        throw new MagiError(
          "blocked",
          `Base branch \`${this.state.pr.metadata.base.ref}\` requires merge queue, but \`review.merge.queue\` is \`false\`. Enable \`review.merge.queue\` or target a branch without merge queue.`,
        )
    }
  }

  if (action !== "merge" || this.config.review.merge.queue)
    this.state = await this.magi.updateState(this.state.output, {
      text: `${action === "merge" ? "Merging" : "Closing"} ${this.getLink()}.`,
    })
  else
    this.state = await this.magi.updateState(this.state.output, {
      text: `Waiting to merge ${this.getLink()}.`,
    })

  if (action === "merge" && this.config.review.merge.queue) {
    const octokit = await this.magi.createOctokit(
      this.config,
      this.context.abort,
      account,
    )
    const graphql = this.magi.createGraphql(octokit)

    await graphql.enqueuePullRequest({ id: this.state.pr!.metadata.node_id })

    this.state = await this.magi.updateState(this.state.output, {
      text: `Waiting for merge queue for ${this.getLink()}.`,
    })

    const result = await waitMergeQueue.call(this)

    if (result === "CONFLICT") return result
  } else {
    const prefix = ["gh", "pr"]
    const suffix = [this.number.toString(), "--repo", this.state.repo]
    const args = [...prefix, action, ...suffix]

    if (action === "merge") {
      if (this.config.review.merge.method === "merge") args.push("--merge")
      if (this.config.review.merge.method === "rebase") args.push("--rebase")
      if (this.config.review.merge.method === "squash") args.push("--squash")
      if (this.config.review.merge.auto) args.push("--auto")
      if (this.config.review.merge.deleteBranch) args.push("--delete-branch")
    }

    const options = { env: { GH_TOKEN: token }, signal: this.context.abort }
    const waitMerge = async (): Promise<PullRequestAutomation> => {
      return await loop<PullRequestAutomation>(async () => {
        this.context.abort.throwIfAborted()

        const data = await this.exec(
          command(
            ...prefix,
            "view",
            ...suffix,
            "--json",
            "autoMergeRequest,mergeStateStatus,state,statusCheckRollup",
          ),
          options,
        )
        const {
          autoMergeRequest: auto,
          mergeStateStatus: status,
          state,
          statusCheckRollup: checks,
        } = JSON.parse(data)

        if (state === "MERGED") return "MERGED"
        if (status === "DIRTY") return "CONFLICT"

        if (status === "BEHIND") {
          this.state = await this.magi.updateState(this.state.output, {
            text: `Updating ${this.getLink()} with the base branch before merging.`,
          })

          await this.exec(
            command(...prefix, "update-branch", ...suffix),
            options,
          )

          return
        }

        if (status === "BLOCKED" && hasFailedChecks(checks))
          throw new MagiError(
            "blocked",
            `Required checks failed before merging ${this.getLink()}.`,
          )
        if (!auto && state === "OPEN")
          throw new MagiError(
            "blocked",
            `Auto-merge is no longer enabled for ${this.getLink()}.`,
          )
      }, 30_000)
    }
    const runAutomation = async (): Promise<PullRequestAutomation | void> => {
      try {
        this.state = await this.magi.updateState(this.state.output, {
          text: `Merging ${this.getLink()}.`,
        })

        await this.exec(command(...args), options)

        if (action === "merge" && this.config.review.merge.auto) {
          const result = await waitMerge()

          if (result === "CONFLICT") {
            this.state = await this.magi.updateState(this.state.output, {
              pr: { automation: "CONFLICT" },
              text: `Merge automation found conflicts for ${this.getLink()}.`,
            })

            return "CONFLICT"
          }
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)

        if (action !== "merge") throw e

        switch (true) {
          case /\bconflicts?\b|merge commit cannot be cleanly created/i.test(
            message,
          ):
            this.state = await this.magi.updateState(this.state.output, {
              pr: { automation: "CONFLICT" },
              text: `Merge automation found conflicts for ${this.getLink()}.`,
            })

            return "CONFLICT"

          case /head (branch|ref) is (not up to date|out of date)/i.test(
            message,
          ):
            this.state = await this.magi.updateState(this.state.output, {
              text: `Updating ${this.getLink()} with the base branch before merging.`,
            })

            await this.exec(
              command(...prefix, "update-branch", ...suffix),
              options,
            )
            await this.exec(command(...args), options)

            if (this.config.review.merge.auto) {
              const result = await waitMerge()

              if (result === "CONFLICT") {
                this.state = await this.magi.updateState(this.state.output, {
                  pr: { automation: "CONFLICT" },
                  text: `Merge automation found conflicts for ${this.getLink()}.`,
                })

                return "CONFLICT"
              }
            }

            break

          default:
            throw e
        }
      }
    }
    const result =
      action === "merge"
        ? await mergeWorker.run(runAutomation)
        : await runAutomation()

    if (result) return result
  }

  this.state = await this.magi.updateState(this.state.output, {
    pr: { automation: action === "merge" ? "MERGED" : "CLOSED" },
    text: `Finished ${action} automation for ${this.getLink()}.`,
  })

  return action === "merge" ? "MERGED" : "CLOSED"
}

function hasFailedChecks(checks: unknown): boolean {
  if (!isArray(checks)) return false

  const latest = checks.reduce<Map<string, Dict>>((prev, check) => {
    if (!isObject<Dict>(check)) return prev

    const key = [check.workflowName, check.name, check.context]
      .filter(isString)
      .join("/")

    if (!key) return prev

    const current = prev.get(key)

    if (!current || getCheckTime(check) >= getCheckTime(current))
      prev.set(key, check)

    return prev
  }, new Map())

  return [...latest.values()].some(isFailedCheck)
}

function isFailedCheck(check: Dict): boolean {
  const regexp = /failure|failed|error|cancelled|timed_out|action_required/i

  return ["conclusion", "state", "status"].some(
    (key) => isString(check[key]) && regexp.test(check[key]),
  )
}

function getCheckTime(check: Dict): number {
  return ["startedAt", "completedAt", "updatedAt"].reduce((prev, key) => {
    const value = check[key]

    if (!isString(value)) return prev

    const time = Date.parse(value)

    return Number.isNaN(time) ? prev : Math.max(prev, time)
  }, 0)
}

async function waitMergeQueue(
  this: Review,
  leftMergeQueue = false,
): Promise<PullRequestAutomation> {
  this.context.abort.throwIfAborted()

  const { repository } = await this.graphql.mergeQueueStatus({
    owner: this.config.github.owner,
    pr: this.number,
    repo: this.config.github.repo,
  })

  if (!repository?.pullRequest)
    throw new MagiError("blocked", "Could not fetch merge queue status.")

  const { isInMergeQueue, mergeQueueEntry, state } = repository.pullRequest

  if (state === "MERGED") return "MERGED"

  const nextLeftMergeQueue =
    state === "OPEN" && !isInMergeQueue && !mergeQueueEntry

  if (leftMergeQueue && nextLeftMergeQueue) {
    if (await isConflict.call(this)) {
      this.state = await this.magi.updateState(this.state.output, {
        pr: { automation: "CONFLICT" },
        text: `Merge automation found conflicts for ${this.getLink()}.`,
      })

      return "CONFLICT"
    }

    throw new MagiError(
      "blocked",
      `PR left the merge queue before merging ${this.getLink()}.`,
    )
  }

  await wait(30_000)

  return await waitMergeQueue.call(this, nextLeftMergeQueue)
}

async function isConflict(this: Review): Promise<boolean> {
  if (!this.state.worktree) return false
  if (!this.state.pr?.metadata)
    throw new MagiError("blocked", "PR metadata not found.")

  const options = { cwd: this.state.worktree.path, signal: this.context.abort }
  const status = await this.exec(
    command("git", "status", "--porcelain"),
    options,
  )

  if (status)
    throw new MagiError("blocked", "PR worktree has uncommitted changes.")

  await this.exec(
    command(
      "git",
      "fetch",
      "--no-tags",
      quote(this.state.pr.metadata.base.repo.clone_url),
      quote(`refs/heads/${this.state.pr.metadata.base.ref}`),
    ),
    options,
  )

  try {
    try {
      await this.exec(
        command("git", "merge", "--no-commit", "--no-ff", "FETCH_HEAD"),
        options,
      )
    } catch (e) {
      const conflicts = await this.exec(
        command("git", "diff", "--name-only", "--diff-filter=U"),
        options,
      )

      if (!conflicts) throw e

      return true
    }
  } finally {
    try {
      await this.exec(command("git", "merge", "--abort"), options)
    } catch {}
  }

  return false
}
