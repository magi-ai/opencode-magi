import { getConfig, validateConfig } from "@/config"
import { Tool } from "@/utils"
import { tool } from "@opencode-ai/plugin"

export const clear: Tool = function (input) {
  return {
    magi_clear: tool({
      description:
        "Clear all inactive Magi runs by deleting configured sessions, worktrees, branches, and output artifacts.",
      args: {},
      async execute() {
        const config = await getConfig(input)
        const errors = await validateConfig(config)

        if (errors.length) throw new Error(errors.join("\n"))

        return ""
      },
    }),
  }
}
