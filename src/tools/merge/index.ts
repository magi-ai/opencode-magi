import type { Tool } from "@/magi"
import { tool } from "@opencode-ai/plugin"

export const merge: Tool = function (magi) {
  return {
    magi_merge: tool({
      args: {
        dryRun: tool.schema.boolean().optional(),
        prs: tool.schema.string(),
        sync: tool.schema.boolean().optional(),
      },
      description:
        "Start background Magi merge runs for one or more GitHub pull requests with configured Magi agents. After starting, monitor progress yourself when useful; do not tell users to call follow-up tools by name.",
      async execute({
        dryRun: _dryRun = false,
        prs: _prs,
        sync: _sync = false,
      }) {
        const _config = await magi.getConfig({ editor: true })

        return ""
      },
    }),
  }
}
