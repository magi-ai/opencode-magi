import type { ToolContext } from "@opencode-ai/plugin"
import type { Config } from "@/config"
import type { Magi } from "@/magi"
import { join } from "node:path"
import { MagiError } from "@/magi"
import { Review } from "@/tools/review/review"
import { editCycles, postReplies } from "./action"
import { fetchMergeContext, markRepliedReviewers } from "./context"
import { edit, resolveConflict } from "./editor"
import { createReport } from "./report"

interface MergeOptions {
  dryRun: boolean
}

export class Merge extends Review {
  static async init(
    number: number,
    magi: Magi,
    config: Config.Root,
    context: ToolContext,
    options: MergeOptions,
  ): Promise<Merge> {
    const { exec, graphql, octokit, ...rest } = await this.setup(
      number,
      magi,
      config,
      context,
    )
    const editor = {
      account: config.merge.editor!.account,
      author: config.merge.editor!.author,
      model: config.merge.editor!.model,
      permissions: config.merge.editor!.permissions,
    }
    const state = await magi.createState(
      join(config.review.output, number.toString()),
      { ...options, ...rest, command: "merge", editor },
    )

    await magi.updateEvent(state.output, `Started merging.`)

    return new Merge(
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

  public createReport = createReport
  public editCycles = editCycles
  public edit = edit
  public fetchMergeContext = fetchMergeContext
  public markRepliedReviewers = markRepliedReviewers
  public postReplies = postReplies
  public resolveConflict = resolveConflict

  public async createSession(): Promise<void> {
    this.context.abort.throwIfAborted()

    if (!this.state.editor) throw new MagiError("blocked", "Editor not found.")

    await this.updateEvent(`Creating editor session.`)

    const editor = {
      sessionId: await this.magi.createSession(
        this.state.sessionId,
        `magi merge #${this.number} editor`,
        {
          model: this.state.editor.model,
          permissions: this.state.editor.permissions,
        },
        this.context.abort,
      ),
    }

    await this.updateState({ editor })
    await this.updateEvent(`Finished creating editor session.`)
  }
}
