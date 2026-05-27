import { Plugin, ToolDefinition } from "@opencode-ai/plugin"
import { commands } from "@/commands"
import { tools } from "./tools"

export const Magi: Plugin = async function (input, options) {
  return {
    async config(config) {
      config.command = { ...config.command, ...commands }
    },
    tool: Object.values(tools).reduce<Record<string, ToolDefinition>>(
      (prev, tool) => ({ ...prev, ...tool(input, options) }),
      {},
    ),
  }
}

export default Magi
