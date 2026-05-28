import type { Tool } from "@/magi"
import { tool } from "@opencode-ai/plugin"

export const clear: Tool = function (magi) {
  return {
    magi_clear: tool({
      args: {},
      description:
        "Clear all inactive Magi runs by deleting configured sessions, worktrees, branches, and output artifacts.",
      async execute() {
        const config = await magi.getConfig()
        const summary = await magi.clear(config)

        return [
          `Cleared Magi runs: ${summary.run}`,
          `Skipped active runs: ${summary.skipped}`,
          `Sessions deleted: ${summary.session}`,
          `Worktrees deleted: ${summary.worktree}`,
          `Branches deleted: ${summary.branch}`,
          `Outputs deleted: ${summary.output}`,
        ].join("\n")
      },
    }),
  }
}
