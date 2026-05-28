import type { Tool } from "@/magi"
import { tool } from "@opencode-ai/plugin"

export const review: Tool = function (magi) {
  return {
    magi_review: tool({
      args: {
        dryRun: tool.schema.boolean().optional(),
        prs: tool.schema.string(),
        sync: tool.schema.boolean().optional(),
      },
      description:
        "Start background Magi review runs for one or more GitHub pull requests and post the reviews. After starting, monitor progress yourself when useful; do not tell users to call follow-up tools by name.",
      async execute({
        dryRun: _dryRun = false,
        prs: _prs,
        sync: _sync = false,
      }) {
        const _config = await magi.getConfig({ reviewers: true })

        return ""
      },
    }),
  }
}
