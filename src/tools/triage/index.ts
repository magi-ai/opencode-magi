import type { Tool } from "@/magi"

export const triage: Tool = function (magi) {
  return {
    magi_triage: {
      description:
        "Triage one or more issues with configured Magi triage voters.",
      async execute() {
        const _config = await magi.getConfig({ creator: true, voters: true })

        return { content: "" }
      },
      input: {
        additionalProperties: false,
        properties: { dryRun: { type: "boolean" }, issues: { type: "string" } },
        required: ["issues"],
        type: "object",
      },
      name: "magi_triage",
    },
  }
}
