import type { Tool } from "@/magi"
import { tool } from "@opencode-ai/plugin"

export const triage: Tool = function (magi) {
  return {
    magi_triage: tool({
      args: {
        dryRun: tool.schema.boolean().optional(),
        issues: tool.schema.string(),
      },
      description:
        "Triage one or more issues with configured Magi triage voters.",
      async execute({ dryRun: _dryRun = false, issues: _issues }) {
        const _config = await magi.getConfig({ creator: true, voters: true })

        return ""
      },
    }),
  }
}
