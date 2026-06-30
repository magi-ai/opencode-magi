import type { Exec } from "./exec"
import { filterEmpty } from "./array"
import { isObject } from "./assertion"

export function parseIssues(value: string): number[] {
  const numbers = filterEmpty(
    value
      .split(/[\s,]+/)
      .map((item) => item.match(/(?:issues\/|#)?(\d+)$/)?.[1]),
  ).map(Number)

  if (!numbers.length)
    throw new Error("Specify one or more issue numbers or issue URLs.")

  return numbers
}

export function parsePrs(value: string): number[] {
  let options = false

  const numbers = filterEmpty(
    value.split(/[\s,]+/).map((item) => {
      if (item.startsWith("--")) options = true
      if (options) return

      return item.match(/(?:pull\/|#)?(\d+)$/)?.[1]
    }),
  ).map(Number)

  if (!numbers.length)
    throw new Error("Specify one or more PR numbers or PR URLs.")

  return numbers
}

function getErrorMessage(e: unknown): string {
  if (!e || !isObject(e)) return String(e)

  const value = e as {
    message?: unknown
    stderr?: unknown
    stdout?: unknown
  }

  return [value.message, value.stderr, value.stdout]
    .filter((item): item is string => typeof item === "string")
    .join("\n")
}

function isGitHubCommand(command: string): boolean {
  return /(^|\s)gh\s+(api|auth|pr|run)\b/.test(command)
}

function isRateLimitError(e: unknown): boolean {
  return /rate limit/i.test(getErrorMessage(e))
}

export function createExecWithGitHubApiRetry(
  exec: Exec,
  retryAttempts: number,
  delay = 1_000,
): Exec {
  return async (command, options) => {
    for (let attempt = 0; ; attempt += 1)
      try {
        return await exec(command, options)
      } catch (e) {
        if (
          attempt >= retryAttempts ||
          !isGitHubCommand(command) ||
          !isRateLimitError(e)
        )
          throw e

        const ms = delay * 2 ** attempt

        if (0 < ms) {
          if (options?.signal?.aborted)
            throw new DOMException("Aborted", "AbortError")

          await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(resolve, ms)

            options?.signal?.addEventListener(
              "abort",
              () => {
                clearTimeout(timeout)
                reject(new DOMException("Aborted", "AbortError"))
              },
              { once: true },
            )
          })
        }
      }
  }
}
