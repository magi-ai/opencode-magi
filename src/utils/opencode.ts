import type { PluginInput as OriginalPluginInput } from "@opencode-ai/plugin"
import type { OpencodeClient } from "@opencode-ai/sdk/v2"
import { isArray } from "./assertion"

export interface PluginInput extends Omit<OriginalPluginInput, "client"> {
  client: OpencodeClient
}

export async function getModels(input: PluginInput): Promise<string[]> {
  const configProviders = await input.client.config
    .providers({ directory: input.directory })
    .catch(() => undefined)
  const configData =
    configProviders && "data" in configProviders
      ? configProviders.data
      : undefined
  const configAll = configData?.providers
  const models = isArray(configAll)
    ? configAll.flatMap((provider) => {
        const models = Object.keys(provider.models)

        return provider.id ? models.map((id) => `${provider.id}/${id}`) : models
      })
    : []

  if (models.length) return models

  const providers = await input.client.provider
    .list({ directory: input.directory })
    .catch(() => undefined)
  const data = providers && "data" in providers ? providers.data : undefined
  const all = data && "all" in data ? data.all : undefined
  const fallbackModels = isArray(all)
    ? all.flatMap((provider) => Object.keys(provider.models))
    : []

  throw new Error(
    `No OpenCode models found. config.providers: ${models.length}; provider.list: ${fallbackModels.length}.`,
  )
}
