import type { MagiConfig } from "../types"
import { isAbsolute, join } from "node:path"

export type OutputKind = "pr"

const DEFAULT_OUTPUT_DIRS: Record<OutputKind, string> = {
  pr: ".magi/runs/pr",
}

function resolvePath(directory: string, path: string): string {
  return isAbsolute(path) ? path : join(directory, path)
}

export function outputBaseDir(
  directory: string,
  config: MagiConfig,
  kind: OutputKind,
): string {
  return resolvePath(
    directory,
    config.review?.output ?? DEFAULT_OUTPUT_DIRS[kind],
  )
}

export function outputBaseDirs(
  directory: string,
  config: MagiConfig,
): string[] {
  return [outputBaseDir(directory, config, "pr")]
}

export function prRunOutputDir(input: {
  config: MagiConfig
  directory: string
  pr: number
  runId?: string
}): string {
  return join(
    outputBaseDir(input.directory, input.config, "pr"),
    String(input.pr),
    ...(input.runId ? [input.runId] : []),
  )
}
