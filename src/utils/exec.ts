import { exec } from "node:child_process"
import { promisify } from "node:util"

export const execAsync = promisify(exec)

export type Exec = (
  command: string,
  options?: {
    cwd?: string
    env?: { [key: string]: string }
    signal?: AbortSignal
  },
) => Promise<string>

export function createExec(defaultCwd: string): Exec {
  return async function (command, { cwd, env, signal } = {}) {
    const { stdout } = await execAsync(command, {
      cwd: cwd ?? defaultCwd,
      env: { ...process.env, ...env },
      maxBuffer: 1024 * 1024 * 20,
      signal,
    })

    return stdout
  }
}
