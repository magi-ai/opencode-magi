import type { Plugin } from "@opencode/plugin"
import { createExec } from "./exec"

export interface PluginInput {
  client: Plugin.Context
  directory: string
}

export async function getModels(input: PluginInput): Promise<string[]> {
  const models = await input.client.model
    .list({ location: { directory: input.directory } })
    .then(({ data }) => data.map(({ id, providerID }) => `${providerID}/${id}`))
    .catch(() => [])

  if (models.length) return models
  else
    try {
      const output = await createExec(input.directory)("opencode models")

      return output.split("\n").filter((model) => model.includes("/"))
    } catch {
      return []
    }
}
