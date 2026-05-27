import { getConfig, validateConfig } from "@/config"
import { createExec, Tool } from "@/utils"
import { tool } from "@opencode-ai/plugin"

function formatValidation(errors: string[]): string {
  return [
    `Magi config validation: ${errors.length ? "failed" : "passed"}`,
    "",
    "Errors:",
    ...(errors.length ? errors.map((message) => `- ${message}`) : ["- None"]),
  ].join("\n")
}

export const validate: Tool = function (input) {
  const exec = createExec(input.directory)

  return {
    magi_validate: tool({
      description:
        "Validate global and project Magi config presence, merged settings, reviewer rules, model IDs, and GitHub authentication.",
      args: {},
      async execute() {
        try {
          const config = await getConfig(input)
          const errors = await validateConfig(config, { exec })

          return formatValidation(errors)
        } catch (e) {
          return formatValidation([(e as Error).message])
        }
      },
    }),
  }
}
