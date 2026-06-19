import type { PullRequestFinding, PullRequestReviewParams } from "./index.type"
import type { Review } from "./review"
import type { ReviewerState } from "@/magi"
import { MagiError } from "@/magi"
import { Prompt } from "@/prompts"
import { filterEmpty, marker, omitNullish, retry, Worker } from "@/utils"

const events = {
  APPROVED: "APPROVE",
  CHANGES_REQUESTED: "REQUEST_CHANGES",
  CLOSED: "COMMENT",
} as const

export async function postReviews(this: Review) {
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

    const event = events[this.state.pr.verdict]
    const params: PullRequestReviewParams = { ...args, event }

    if (this.state.pr.verdict === "CHANGES_REQUESTED") {
      const findings = Object.entries(this.state.reviewers!).flatMap(
        ([id, { output }]) =>
          (output?.findings ?? output?.newFindings ?? []).map((finding) => ({
            ...finding,
            id,
          })),
      )

      if (!findings.length) {
        this.magi.notify(
          this.state.sessionId,
          `Finished posting reviews for ${this.getLink()}.`,
        )

        return
      }

      params.comments = findings.map(({ body, id, startLine, ...rest }) => ({
        ...rest,
        body: [
          body,
          marker.stringify({ command: "review", reviewer: id }),
        ].join("\n\n"),
        ...(startLine == null
          ? {}
          : { start_line: startLine, start_side: "RIGHT" }),
      }))
    }

    if (this.state.pr.verdict !== "APPROVED") {
      if (!this.state.reporter?.sessionId)
        throw new MagiError("blocked", "Reporter session ID not found.")

      await this.magi.notify(
        this.state.sessionId,
        `Generating comment for ${this.getLink()} by reporter.`,
      )

      const contents = JSON.stringify(
        Object.values(this.state.reviewers!).flatMap<
          PullRequestFinding | string
        >(({ output }) => {
          if (!output || output.verdict === "APPROVED") return []

          if (output.verdict === "CLOSED") {
            return [output.comment!]
          } else {
            return output.findings ?? output.newFindings ?? []
          }
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
            this.state.reporter!.sessionId!,
            count === 1 ? taskMessage : repairMessage,
          )
          const parsed = prompt.parse(raw)

          if (!prompt.validate<{ comment: string }>(parsed))
            throw new Error("Invalid output for reporter.")

          return parsed.comment
        },
        {
          error: (_, count) =>
            this.magi.notify(
              this.state.sessionId,
              `Attempt ${count} failed to post comment for ${this.getLink()} by reporter. Retrying...`,
            ),
          retries: this.config.output.repairAttempts,
        },
      )

      if (!output)
        throw new MagiError("blocked", "Invalid output for reporter.")

      await this.magi.notify(
        this.state.sessionId,
        `Generated comment for ${this.getLink()} by reporter.`,
      )

      params.body = output
    }

    params.body = [
      params.body ?? "",
      marker.stringify(
        ...filterEmpty(
          Object.entries(this.state.reviewers!).map(([id, { output }]) => {
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
          ([id, { account, output, review, status }]) =>
            worker.run(async () => {
              if (status === "skip") return [id, { posted: review?.html_url }]
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
                (output.followUps ?? []).map(async ({ body, commentId }) =>
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
                const findings = output.findings ?? output.newFindings ?? []

                if (!findings.length) return [id, {}]

                params.comments = findings.map(({ startLine, ...rest }) => ({
                  ...rest,
                  ...(startLine == null
                    ? {}
                    : { start_line: startLine, start_side: "RIGHT" }),
                }))
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
