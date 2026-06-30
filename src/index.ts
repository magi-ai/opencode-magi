import type { Plugin } from "@opencode-ai/plugin"
import type { Tool } from "./magi"
import { commands } from "@/commands"
import { Magi } from "./magi"
import { tools } from "./tools"

export const plugin: Plugin = async function (input, options) {
  const magi = new Magi(input, options)

  return Promise.resolve({
    async config(config) {
      config.command = { ...config.command, ...commands }

      return Promise.resolve()
    },
    tool: Object.values(tools).reduce<ReturnType<Tool>>(
      (prev, tool) => ({ ...prev, ...tool(magi) }),
      {},
    ),
  })
}

export default plugin
