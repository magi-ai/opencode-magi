import type { Config } from "."
import type { PluginInput } from "@/utils"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { CONFIG_PATH, DEFAULT_CONFIG } from "@/constant"
import {
  filterEmpty,
  getModels,
  isArray,
  isObject,
  isString,
  merge,
} from "@/utils"

type PermissionRuleset = {
  action: Config.PermissionAction
  pattern: string
  permission: string
}[]

export function resolvePermissions(
  permissions?: Config.Permissions,
): PermissionRuleset | undefined {
  if (!permissions) return undefined

  if (isString(permissions))
    return [
      "read",
      "edit",
      "glob",
      "grep",
      "bash",
      "task",
      "skill",
      "lsp",
      "webfetch",
      "websearch",
      "external_directory",
      "doom_loop",
    ].map((permission) => ({
      action: permissions,
      pattern: "*",
      permission,
    }))
  else
    return Object.entries(permissions).flatMap(([permission, rule]) => {
      if (isString(rule)) return [{ action: rule, pattern: "*", permission }]
      else
        return Object.entries(rule).map(([pattern, action]) => ({
          action,
          pattern,
          permission,
        }))
    })
}

function mergePermissions(
  base: Config.Permissions,
  override?: Config.Permissions,
): Config.Permissions {
  if (!override) return base
  else if (isString(override) || isString(base)) return override
  else return merge(base, override)
}

function mergeAgent<T extends Config.Agent>(base: Config.Root, agent: T): T {
  if (base.agents.refs && agent.ref)
    agent = { ...base.agents.refs[agent.ref], ...agent }

  agent.permissions = mergePermissions(
    base.agents.permissions,
    agent.permissions,
  )

  if (base.account) agent.account ??= base.account

  return agent
}

function resolveModel(
  models: string[],
  model: Config.Model | undefined,
): Config.ModelWithOptions | undefined {
  if (isArray(model))
    model =
      model.find((model) =>
        isString(model) ? models.includes(model) : models.includes(model.id),
      ) ?? model[0]

  if (!model) return undefined

  if (isString(model)) return { id: model }
  else return model
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
  const results = filterEmpty(data)

  if (!results.length)
    throw new Error(
      `No Magi config found. Expected ${CONFIG_PATH.GLOBAL} or ${projectPath}.`,
    )

  const config = results.reduce(
    (prev, current) => merge<Config.Root>(prev, current),
    DEFAULT_CONFIG,
  )

  config.github.url = `https://${config.github.host}/${config.github.owner}/${config.github.repo}`

  if (config.review.reviewers)
    config.review.reviewers = config.review.reviewers.map((agent, index) => {
      const { id, model, ...rest } = mergeAgent(config, agent)

      return {
        ...rest,
        id: id || `reviewer-${index + 1}`,
        model: resolveModel(models, model),
      }
    })

  config.merge.editor = mergeAgent(config, config.merge.editor)
  config.merge.editor.model = resolveModel(models, config.merge.editor.model)

  if (config.triage.voters)
    config.triage.voters = config.triage.voters.map((agent, index) => {
      const { id, model, ...rest } = mergeAgent(config, agent)

      return {
        ...rest,
        id: id || `voter-${index + 1}`,
        model: resolveModel(models, model),
      }
    })

  config.triage.creator = mergeAgent(config, config.triage.creator)
  config.triage.creator.model = resolveModel(
    models,
    config.triage.creator.model,
  )

  return config
}
