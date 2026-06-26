import type {
  PullRequestAutomation,
  PullRequestFinding,
  PullRequestReviewParams,
} from "./index.type"
import type { Review } from "./review"
import type { ReviewerState } from "@/magi"
import { MagiError } from "@/magi"
import { Prompt } from "@/prompts"
import {
  command,
  filterEmpty,
  isArray,
  isObject,
  loop,
  marker,
  omitNullish,
  quote,
  retry,
  Worker,
} from "@/utils"

const events = {
  APPROVED: "APPROVE",
  CHANGES_REQUESTED: "REQUEST_CHANGES",
  CLOSED: "COMMENT",
} as const

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
        this.magi.notify(
          this.state.sessionId,
          `Finished posting reviews for ${this.getLink()}.`,
        )

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

      await this.magi.notify(
        this.state.sessionId,
        `Generating comment for ${this.getLink()} by operator.`,
      )

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
      const taskMessage = await prompt.create(undefined, ["output_contract"], {
        contents,
        owner: this.config.github.owner,
        pr: this.number.toString(),
        repo: this.config.github.repo,
        verdict: this.state.pr.verdict,
      })
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
            this.magi.notify(
              this.state.sessionId,
              `Attempt ${count} failed to post comment for ${this.getLink()} by operator. Retrying...`,
            ),
          retries: this.config.output.repairAttempts,
        },
      )

      if (!output)
        throw new MagiError("blocked", "Invalid output for operator.")

      await this.magi.notify(
        this.state.sessionId,
        `Generated comment for ${this.getLink()} by operator.`,
      )

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

      if (!enabledMergeQueue)
        throw new MagiError(
          "blocked",
          `Base branch \`${this.state.pr.metadata.base.ref}\` requires merge queue, but \`review.merge.queue\` is \`false\`. Enable \`review.merge.queue\` or target a branch without merge queue.`,
        )
    }
  }

  this.state = await this.magi.updateState(this.state.output, {
    text: `${action === "merge" ? "Merging" : "Closing"} ${this.getLink()}.`,
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

    const result = await loop<PullRequestAutomation>(async () => {
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

      if (state === "OPEN" && !isInMergeQueue && !mergeQueueEntry) {
        await this.checkCi(false)

        if (this.state.pr?.checks?.failed.length) {
          this.state = await this.magi.updateState(this.state.output, {
            pr: { automation: "FAILED" },
            text: `Merge automation found failed checks for ${this.getLink()}.`,
          })

          return "FAILED"
        }

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
    }, 30_000)

    if (result === "CONFLICT" || result === "FAILED") return result
  } else {
    const args = [
      "gh",
      "pr",
      action,
      this.number.toString(),
      "--repo",
      this.state.repo,
    ]

    if (action === "merge") {
      if (this.config.review.merge.method === "merge") args.push("--merge")
      if (this.config.review.merge.method === "rebase") args.push("--rebase")
      if (this.config.review.merge.method === "squash") args.push("--squash")
      if (this.config.review.merge.auto) args.push("--auto")
      if (this.config.review.merge.deleteBranch) args.push("--delete-branch")
    }

    try {
      await this.exec(command(...args), {
        env: { GH_TOKEN: token },
        signal: this.context.abort,
      })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)

      if (/merge queue enabled/i.test(message)) throw e
      if (
        !/\bconflicts?\b|not mergeable|merge commit cannot be cleanly created/i.test(
          message,
        )
      )
        throw e

      this.state = await this.magi.updateState(this.state.output, {
        pr: { automation: "CONFLICT" },
        text: `Merge automation found conflicts for ${this.getLink()}.`,
      })

      return "CONFLICT"
    }
  }

  this.state = await this.magi.updateState(this.state.output, {
    pr: { automation: action === "merge" ? "MERGED" : "CLOSED" },
    text: `Finished ${action} automation for ${this.getLink()}.`,
  })

  return action === "merge" ? "MERGED" : "CLOSED"
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
