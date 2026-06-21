import type { ToolContext } from "@opencode-ai/plugin"
import type { Config } from "@/config"
import type { Magi } from "@/magi"
import { join } from "node:path"
import { Review } from "@/tools/review/review"
import { createExecWithGitHubApiRetry, quote } from "@/utils"

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
    const state = await magi.createState(
      join(config.review.output, number.toString()),
      {
        command: "merge",
        dryRun: options.dryRun,
        pr: { number, url },
        repo: quote(`${config.github.owner}/${config.github.repo}`),
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
}
