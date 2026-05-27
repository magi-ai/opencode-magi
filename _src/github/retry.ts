import type { Exec } from "../types"

function errorText(error: unknown): string {
  if (!error || typeof error !== "object") return String(error)

  const value = error as {
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

function isRateLimitError(error: unknown): boolean {
  return /rate limit/i.test(errorText(error))
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError")

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, ms)

    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout)
        reject(new DOMException("Aborted", "AbortError"))
      },
      { once: true },
    )
  })
}

export function withGitHubApiRetry(
  exec: Exec,
  retryAttempts: number,
  delayMs = 1_000,
): Exec {
  return async (command, options) => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await exec(command, options)
      } catch (error) {
        if (
          attempt >= retryAttempts ||
          !isGitHubCommand(command) ||
          !isRateLimitError(error)
        ) {
          throw error
        }

        await delay(delayMs * 2 ** attempt, options?.signal)
      }
    }
  }
}
