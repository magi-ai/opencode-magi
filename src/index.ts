import type { Plugin, ToolDefinition } from "@opencode-ai/plugin"
import { commands } from "@/commands"
import { tools } from "./tools"

export const Magi: Plugin = async function (input, options) {
  return Promise.resolve({
    async config(config) {
      config.command = { ...config.command, ...commands }

      return Promise.resolve()
    },
    tool: Object.values(tools).reduce<{ [key: string]: ToolDefinition }>(
      (prev, tool) => ({ ...prev, ...tool(input, options) }),
      {},
    ),
  })
}

export default Magi
