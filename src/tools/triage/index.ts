import { getConfig, validateConfig } from "@/config"
import { createExec, Tool } from "@/utils"
import { tool } from "@opencode-ai/plugin"

export const triage: Tool = function (input) {
  const exec = createExec(input.directory)

  return {
    magi_triage: tool({
      description:
        "Triage one or more GitHub issues with configured Magi triage voters.",
      args: {
        issues: tool.schema.string(),
        dryRun: tool.schema.boolean().optional(),
        sync: tool.schema.boolean().optional(),
      },
      async execute({
        issues: _issues,
        dryRun: _dryRun = false,
        sync: _sync = false,
      }) {
        const config = await getConfig(input)
        const errors = await validateConfig(config, {
          exec,
          require: { voters: true, creator: true },
        })

        if (errors.length) throw new Error(errors.join("\n"))

        return ""
      },
    }),
  }
}
