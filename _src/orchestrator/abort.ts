import type { Exec } from "../types"

export function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted()
}

export function withAbortSignal(exec: Exec, signal?: AbortSignal): Exec {
  return async (command, options) => {
    throwIfAborted(signal)

    return exec(command, { ...options, signal: options?.signal ?? signal })
  }
}
