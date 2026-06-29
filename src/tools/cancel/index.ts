import type { Tool } from "@/magi"
import { tool } from "@opencode-ai/plugin"

export const cancel: Tool = function (magi) {
  return {
    magi_cancel: tool({
      args: {
        numbers: tool.schema.number().array().optional(),
      },
      description:
        "Cancel active background Magi runs by pull request or issue number, or all active background runs when no target is provided.",
      async execute({ numbers }) {
        const result = magi.cancelBackgrounds(numbers)

        if (!result.cancelled.length && !result.missing.length)
          return await Promise.resolve("No active background runs.")

        return await Promise.resolve(
          [
            ...(result.cancelled.length
              ? [
                  `Cancelled: ${result.cancelled.length}`,
                  ...result.cancelled.map((number) => `- ${number}`),
                ]
              : []),
            ...(result.missing.length
              ? [
                  `Missing: ${result.missing.length}`,
                  ...result.missing.map((number) => `- ${number}`),
                ]
              : []),
          ].join("\n"),
        )
      },
    }),
  }
}
