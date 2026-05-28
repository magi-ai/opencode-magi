import type { Tool } from "@/utils"
import { tool } from "@opencode-ai/plugin"
import { getConfig, validateConfig } from "@/config"
import { createExec } from "@/utils"

export const triage: Tool = function (input) {
  const exec = createExec(input.directory)

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
        const config = await getConfig(input)
        const errors = await validateConfig(config, {
          exec,
          require: { creator: true, voters: true },
        })

        if (errors.length) throw new Error(errors.join("\n"))

        return ""
      },
    }),
  }
}
