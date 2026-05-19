import type { WorktreeConfig } from "../types"
import { isAbsolute, join } from "node:path"

export type WorktreeKind = "pr"

const DEFAULT_WORKTREE_DIRS: Record<WorktreeKind, string> = {
  pr: ".magi/worktrees/pr",
}

function resolvePath(directory: string, path: string): string {
  return isAbsolute(path) ? path : join(directory, path)
}

export function worktreeBaseDir(
  directory: string,
  config: { worktree?: WorktreeConfig },
  kind: WorktreeKind,
): string {
  return resolvePath(
    directory,
    config.worktree?.dirs?.[kind] ?? DEFAULT_WORKTREE_DIRS[kind],
  )
}

export function worktreeBaseDirs(
  directory: string,
  config: { worktree?: WorktreeConfig } = {},
): string[] {
  return [worktreeBaseDir(directory, config, "pr")]
}
