import type { MagiConfig } from "../types"
import { isAbsolute, join } from "node:path"

export type WorktreeKind = "issue" | "pr"

const DEFAULT_WORKTREE_DIRS: Record<WorktreeKind, string> = {
  issue: ".magi/worktrees/issue",
  pr: ".magi/worktrees/pr",
}

function resolvePath(directory: string, path: string): string {
  return isAbsolute(path) ? path : join(directory, path)
}

export function worktreeBaseDir(
  directory: string,
  config: MagiConfig,
  kind: WorktreeKind,
): string {
  return resolvePath(
    directory,
    kind === "issue"
      ? (config.triage?.worktree ?? DEFAULT_WORKTREE_DIRS[kind])
      : (config.review?.worktree ?? DEFAULT_WORKTREE_DIRS[kind]),
  )
}

export function worktreeBaseDirs(
  directory: string,
  config: MagiConfig = {},
): string[] {
  return [
    worktreeBaseDir(directory, config, "pr"),
    worktreeBaseDir(directory, config, "issue"),
  ]
}

export function prRunWorktreeDir(input: {
  config: MagiConfig
  directory: string
  pr: number
  runId: string
}): string {
  return join(
    worktreeBaseDir(input.directory, input.config, "pr"),
    String(input.pr),
    input.runId,
  )
}

export function issueRunWorktreeDir(input: {
  config: MagiConfig
  directory: string
  issue: number
  runId: string
}): string {
  return join(
    worktreeBaseDir(input.directory, input.config, "issue"),
    String(input.issue),
    input.runId,
  )
}
