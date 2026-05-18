import type { MagiConfig } from "../types"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"

const GLOBAL_CONFIG = join(homedir(), ".config", "opencode", "magi.json")
const PROJECT_CONFIG = join(".opencode", "magi.json")

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  )
}

export function mergeMagiConfig(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...base }

  for (const [key, value] of Object.entries(override)) {
    const existing = merged[key]

    merged[key] =
      isPlainObject(existing) && isPlainObject(value)
        ? mergeMagiConfig(existing, value)
        : value
  }

  return merged
}

async function readConfig(
  path: string,
): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT") return null

    throw error
  }
}

export async function loadConfig(
  directory: string,
  configPath?: string,
): Promise<{ config: MagiConfig; path: string }> {
  if (configPath) {
    const path = isAbsolute(configPath)
      ? configPath
      : join(directory, configPath)
    const config = await readConfig(path)

    if (!config) throw new Error(`Magi config not found: ${path}`)

    return { config: config as unknown as MagiConfig, path }
  }

  const projectPath = join(directory, PROJECT_CONFIG)
  const configs = await Promise.all([
    readConfig(GLOBAL_CONFIG),
    readConfig(projectPath),
  ])
  const loaded = configs
    .map((config, index) => ({
      config,
      path: index === 0 ? GLOBAL_CONFIG : projectPath,
    }))
    .filter((item): item is { config: Record<string, unknown>; path: string } =>
      Boolean(item.config),
    )

  if (!loaded.length)
    throw new Error(
      `Magi config not found. Tried: ${GLOBAL_CONFIG}, ${projectPath}`,
    )

  const config = loaded.reduce<Record<string, unknown>>(
    (merged, item) => mergeMagiConfig(merged, item.config),
    {},
  )

  return {
    config: config as unknown as MagiConfig,
    path: loaded.map((item) => item.path).join(", "),
  }
}
