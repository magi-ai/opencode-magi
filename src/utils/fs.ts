import type { RmOptions as OriginalRmOptions } from "node:fs"
import { rm as originalRm, readdir, rmdir } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve } from "node:path"
import { isString } from "./assertion"

export interface RmOptions extends OriginalRmOptions {
  prune?: boolean | string
}

export async function rm(
  path: string,
  { prune, ...options }: RmOptions = {},
): Promise<void> {
  await originalRm(path, options)

  if (!prune) return

  const root = resolve(isString(prune) ? prune : process.cwd())

  let dir = dirname(resolve(path))

  while (dir !== root) {
    const value = relative(root, dir)

    if (!value || value.startsWith("..") || isAbsolute(value)) break

    try {
      if ((await readdir(dir)).length) break

      await rmdir(dir)
    } catch {
      break
    }

    dir = dirname(dir)
  }
}
