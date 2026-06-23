import type { Merge } from "./merge"
import { MagiError } from "@/magi"

export async function postReplies(this: Merge): Promise<void> {
  this.context.abort.throwIfAborted()

  if (this.state.dryRun) return

  if (!this.state.editor?.output)
    throw new MagiError("blocked", "Editor output not found.")

  if (!this.state.editor.output.responses.length) return

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
    this.state.editor.output!.responses.map(({ body, commentId }) =>
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
