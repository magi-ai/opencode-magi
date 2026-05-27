import { Config } from "."
import { CONFIG_PATH, DEFAULT_CONFIG } from "@/constant"
import { PluginInput } from "@opencode-ai/plugin"
import { readFile } from "node:fs/promises"
import { getModels, isArray, isObject, isString, merge } from "@/utils"
import { join } from "node:path"

function mergePermissions(
  base: Config.Permissions,
  override?: Config.Permissions,
): Config.Permissions {
  if (!override) {
    return base
  } else if (isString(override) || isString(base)) {
    return override
  } else {
    return merge(base, override)
  }
}

function mergeAgent<T extends Config.Agent>(base: Config.Root, agent: T): T {
  if (base.agents) {
    if (base.agents.refs && agent.ref) {
      agent = { ...base.agents.refs[agent.ref], ...agent }
    }

    if (base.agents.permissions) {
      agent.permissions = mergePermissions(
        base.agents?.permissions,
        agent.permissions,
      )
    }
  }

  if (base.account) agent.account ??= base.account

  return agent
}

function resolveModel(
  models: string[],
  model: Config.Model | undefined,
): Config.ModelWithOptions | undefined {
  if (isArray(model)) {
    model = model.filter((model) =>
      isString(model) ? models.includes(model) : models.includes(model.id),
    )[0]
  }

  if (!model) return undefined

  if (isString(model)) {
    return models.includes(model) ? { id: model } : undefined
  } else {
    return models.includes(model.id) ? model : undefined
  }
}

async function readConfig(path: string): Promise<Config.Root | undefined> {
  try {
    const config = JSON.parse(await readFile(path, "utf8"))

    if (!isObject<Config.Root>(config))
      throw new Error(`Config must be a JSON object: ${path}`)

    return config
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined

    throw e
  }
}

export async function getConfig(input: PluginInput): Promise<Config.Root> {
  const projectPath = join(input.directory, CONFIG_PATH.PROJECT)
  const [models, ...data] = await Promise.all([
    getModels(input),
    readConfig(CONFIG_PATH.GLOBAL),
    readConfig(projectPath),
  ])
  const results = data.filter((data) => !!data)

  if (!results.length) {
    throw new Error(
      `No Magi config found. Expected ${CONFIG_PATH.GLOBAL} or ${projectPath}.`,
    )
  }

  const config = results.reduce(
    (prev, current) => merge<Config.Root>(prev, current),
    DEFAULT_CONFIG,
  )

  if (config.review?.reviewers) {
    config.review.reviewers = config.review.reviewers.map((agent, index) => {
      const { id, model, ...rest } = mergeAgent(config, agent)

      return {
        ...rest,
        id: id ?? `reviewer-${index + 1}`,
        model: resolveModel(models, model),
      }
    })
  }

  if (config.merge?.editor) {
    config.merge.editor = mergeAgent(config, config.merge.editor)
    config.merge.editor.model = resolveModel(models, config.merge.editor.model)
  }

  if (config.triage?.voters) {
    config.triage.voters = config.triage.voters.map((agent, index) => {
      const { id, model, ...rest } = mergeAgent(config, agent)

      return {
        ...rest,
        id: id ?? `voter-${index + 1}`,
        model: resolveModel(models, model),
      }
    })
  }

  if (config.triage?.creator) {
    config.triage.creator = mergeAgent(config, config.triage.creator)
    config.triage.creator.model = resolveModel(
      models,
      config.triage.creator.model,
    )
  }

  return config
}
