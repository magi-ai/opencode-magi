import type { Tool } from "@/magi"
import { tool } from "@opencode-ai/plugin"

export const triage: Tool = function (magi) {
  return {
    magi_triage: tool({
      args: {
        dryRun: tool.schema.boolean().optional(),
        issues: tool.schema.string(),
        sync: tool.schema.boolean().optional(),
      },
      description:
        "Triage one or more GitHub issues with configured Magi triage voters.",
      async execute({
        dryRun: _dryRun = false,
        issues: _issues,
        sync: _sync = false,
      }) {
        const _config = await magi.getConfig({ creator: true, voters: true })

        return ""
      },
    }),
  }
}
