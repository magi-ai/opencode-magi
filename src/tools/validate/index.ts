import type { Tool } from "@/magi"
import { getConfig, validateConfig } from "@/config"

function createReport(errors: string[]): string {
  return [
    `Magi config validation: ${errors.length ? "failed" : "passed"}`,
    "",
    "Errors:",
    ...(errors.length ? errors.map((message) => `- ${message}`) : ["- None"]),
  ].join("\n")
}

export const validate: Tool = function (magi) {
  return {
    magi_validate: {
      description:
        "Validate global and project Magi config presence, merged settings, reviewer rules, model IDs, and account authentication.",
      async execute() {
        try {
          const config = await getConfig(magi.input)
          const errors = await validateConfig(config, { exec: magi.exec })

          return { content: createReport(errors) }
        } catch (e) {
          return { content: createReport([(e as Error).message]) }
        }
      },
      input: { additionalProperties: false, properties: {}, type: "object" },
      name: "magi_validate",
    },
  }
}
