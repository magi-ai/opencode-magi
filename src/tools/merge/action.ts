import type { Merge } from "./merge"
import type { PullRequestVerdict } from "@/tools/review"
import { MagiError } from "@/magi"
import { retry } from "@/utils"

export async function editCycles(
  this: Merge,
  callback: (cycle: number) => Promise<PullRequestVerdict>,
): Promise<void> {
  this.context.abort.throwIfAborted()

  const error = new Error("Continue edit cycle.")
  const verdict = await retry<PullRequestVerdict>(
    async (cycle) => {
      const verdict = await callback(cycle)

      if (verdict === "CHANGES_REQUESTED") throw error

      return verdict
    },
    {
      error: (e, count) => {
        if (e !== error) throw e

        this.notify(
          `Attempt ${count} failed to edit cycles for ${this.getLink()}. Retrying...`,
        )
      },
      retries: this.config.merge.maxThreadResolutionCycles,
    },
  )

  if (!verdict || verdict === "CHANGES_REQUESTED")
    throw new MagiError(
      "blocked",
      `Reached maximum edit cycles for ${this.getLink()}.`,
    )
}

export async function postReplies(this: Merge): Promise<void> {
  this.context.abort.throwIfAborted()

  if (this.state.dryRun) return

  const output = this.state.editor?.outputs?.at(-1)

  if (!output) throw new MagiError("blocked", "Editor output not found.")

  if (!output.responses.length) return

  this.state = await this.magi.updateState(this.state.output, {
    text: `Posting editor replies for ${this.getLink()}.`,
  })

  if (!this.state.editor?.account)
    throw new MagiError("blocked", "Editor account not found.")

  const octokit = await this.magi.createOctokit(
    this.config,
    this.context.abort,
    this.state.editor.account,
  )
  const args = {
    owner: this.config.github.owner,
    pull_number: this.number,
    repo: this.config.github.repo,
  }

  await Promise.all(
    output.responses.map(({ body, commentId }) =>
      octokit.rest.pulls.createReplyForReviewComment({
        ...args,
        body,
        comment_id: commentId,
      }),
    ),
  )

  this.state = await this.magi.updateState(this.state.output, {
    text: `Finished posting editor replies for ${this.getLink()}.`,
  })
}
