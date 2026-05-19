import type { MagiConfig } from "../types"
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
  config: MagiConfig,
  kind: WorktreeKind,
): string {
  return resolvePath(
    directory,
    config.review?.worktree ?? DEFAULT_WORKTREE_DIRS[kind],
  )
}

export function worktreeBaseDirs(
  directory: string,
  config: MagiConfig = {},
): string[] {
  return [worktreeBaseDir(directory, config, "pr")]
}
