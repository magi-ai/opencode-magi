import type { Tool } from "@/utils"
import { tool } from "@opencode-ai/plugin"
import { getConfig, validateConfig } from "@/config"
import { createExec } from "@/utils"

export const merge: Tool = function (input) {
  const exec = createExec(input.directory)

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
        const config = await getConfig(input)
        const errors = await validateConfig(config, {
          exec,
          require: { editor: true },
        })

        if (errors.length) throw new Error(errors.join("\n"))

        return ""
      },
    }),
  }
}
