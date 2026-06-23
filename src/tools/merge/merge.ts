import type { ToolContext } from "@opencode-ai/plugin"
import type { Config } from "@/config"
import type { Magi } from "@/magi"
import { join } from "node:path"
import { MagiError } from "@/magi"
import { Review } from "@/tools/review/review"
import { createExecWithGitHubApiRetry, quote } from "@/utils"
import { postReplies } from "./action"
import { fetchMergeContext, markRepliedReviewers } from "./context"
import { edit } from "./editor"
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
  ) {
    const url = `${config.github.url}/pull/${number}`
    const octokit = await magi.createOctokit(config, context.abort)
    const graphql = magi.createGraphql(octokit)
    const reviewers = Object.fromEntries(
      config.review.reviewers!.map(
        ({ account, id, model, permissions }) =>
          [id, { account, model, permissions }] as const,
      ),
    )
    const operator = config.review.operator
      ? config.review.reviewers!.find(
          ({ id }) => id === config.review.operator,
        )!
      : config.review.reviewers![
          Math.abs(number) % config.review.reviewers!.length
        ]!
    const editor = {
      account: config.merge.editor.account,
      author: config.merge.editor.author,
      model: config.merge.editor.model,
      permissions: config.merge.editor.permissions,
    }
    const state = await magi.createState(
      join(config.review.output, number.toString()),
      {
        command: "merge",
        dryRun: options.dryRun,
        editor,
        operator,
        pr: { number, url },
        repo: quote(`${config.github.owner}/${config.github.repo}`),
        reviewers,
        sessionId: context.sessionID,
        text: `Started merging [#${number}](${url}).`,
      },
    )
    const exec = createExecWithGitHubApiRetry(
      magi.exec,
      config.github.retryApiAttempts,
    )

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
  public edit = edit
  public fetchMergeContext = fetchMergeContext
  public markRepliedReviewers = markRepliedReviewers
  public postReplies = postReplies

  public async createSession() {
    this.context.abort.throwIfAborted()

    if (!this.state.editor) throw new MagiError("blocked", "Editor not found.")

    this.state = await this.magi.updateState(this.state.output, {
      text: `Creating editor session for ${this.getLink()}.`,
    })

    const editor = {
      sessionId: await this.magi.createSession(
        this.state.sessionId,
        `magi merge #${this.number} editor`,
        {
          model: this.state.editor!.model,
          permissions: this.state.editor!.permissions,
        },
      ),
    }

    this.state = await this.magi.updateState(this.state.output, {
      editor,
      text: `Finished creating editor session for ${this.getLink()}.`,
    })

    return editor
  }
}
