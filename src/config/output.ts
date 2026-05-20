import type { MagiConfig } from "../types"
import { isAbsolute, join } from "node:path"

export type OutputKind = "issue" | "pr"

const DEFAULT_OUTPUT_DIRS: Record<OutputKind, string> = {
  issue: ".magi/runs/issue",
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
    kind === "issue"
      ? (config.triage?.output ?? DEFAULT_OUTPUT_DIRS[kind])
      : (config.review?.output ?? DEFAULT_OUTPUT_DIRS[kind]),
  )
}

export function outputBaseDirs(
  directory: string,
  config: MagiConfig,
): string[] {
  return [
    outputBaseDir(directory, config, "pr"),
    outputBaseDir(directory, config, "issue"),
  ]
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

export function issueRunOutputDir(input: {
  config: MagiConfig
  directory: string
  issue: number
  runId?: string
}): string {
  return join(
    outputBaseDir(input.directory, input.config, "issue"),
    String(input.issue),
    ...(input.runId ? [input.runId] : []),
  )
}
