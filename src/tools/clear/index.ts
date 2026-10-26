import type { Tool } from "@/magi"

export const clear: Tool = function (magi) {
  return {
    magi_clear: {
      description:
        "Clear all inactive Magi runs by deleting configured sessions, worktrees, branches, and output artifacts.",
      async execute() {
        const config = await magi.getConfig()
        const summary = await magi.clear(config)

        return {
          content: [
            `Cleared Magi runs: ${summary.run}`,
            `Skipped active runs: ${summary.skipped}`,
            `Sessions deleted: ${summary.session}`,
            `Worktrees deleted: ${summary.worktree}`,
            `Branches deleted: ${summary.branch}`,
            `Outputs deleted: ${summary.output}`,
          ].join("\n"),
        }
      },
      input: { additionalProperties: false, properties: {}, type: "object" },
      name: "magi_clear",
    },
  }
}
