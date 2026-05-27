import { getConfig, validateConfig } from "@/config"
import { createExec, Tool } from "@/utils"
import { tool } from "@opencode-ai/plugin"

export const merge: Tool = function (input) {
  const exec = createExec(input.directory)

  return {
    magi_merge: tool({
      description:
        "Start background Magi merge runs for one or more GitHub pull requests with configured Magi agents. After starting, monitor progress yourself when useful; do not tell users to call follow-up tools by name.",
      args: {
        prs: tool.schema.string(),
        dryRun: tool.schema.boolean().optional(),
        sync: tool.schema.boolean().optional(),
      },
      async execute({
        prs: _prs,
        dryRun: _dryRun = false,
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
