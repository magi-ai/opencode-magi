import type { PluginInput } from "@opencode-ai/plugin"

export async function getModels(input: PluginInput): Promise<string[]> {
  const providers = await input.client.config
    .providers({ query: { directory: input.directory } })
    .catch(() =>
      input.client.provider.list({ query: { directory: input.directory } }),
    )
  const data = "data" in providers ? providers.data : undefined
  const all = data && "providers" in data ? data.providers : data?.all

  return Array.isArray(all)
    ? all.flatMap((provider) => Object.keys(provider.models))
    : []
}
