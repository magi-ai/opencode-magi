import type { PluginInput as OriginalPluginInput } from "@opencode-ai/plugin"
import type { OpencodeClient } from "@opencode-ai/sdk/v2"
import { isArray } from "./assertion"
import { createExec } from "./exec"

export interface PluginInput extends Omit<OriginalPluginInput, "client"> {
  client: OpencodeClient
}

export async function getModels(input: PluginInput): Promise<string[]> {
  const providers = await input.client.config
    .providers({ directory: input.directory })
    .catch(() => input.client.provider.list({ directory: input.directory }))
  const data = "data" in providers ? providers.data : undefined
  const all = data && "providers" in data ? data.providers : data?.all
  const models = isArray(all)
    ? all.flatMap((provider) => {
        const models = Object.keys(provider.models)

        return provider.id ? models.map((id) => `${provider.id}/${id}`) : models
      })
    : []

  if (models.length) return models
  else
    try {
      const output = await createExec(input.directory)("opencode models")

      return output.split("\n").filter((model) => model.includes("/"))
    } catch {
      return []
    }
}
