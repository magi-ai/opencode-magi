export function wait(ms = 0, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()

  return new Promise<void>((resolve, reject) => {
    const abort = (): void => {
      clearTimeout(timeout)
      reject(signal?.reason)
    }
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", abort)
      resolve()
    }, ms)

    signal?.addEventListener("abort", abort, { once: true })
  })
}

export async function loop<T>(
  callback: () => Promise<T | void> | T | void,
  ms = 0,
): Promise<T> {
  for (;;) {
    const value = await callback()

    if (value != null) return value

    await wait(ms)
  }
}

export interface RetryOptions {
  error?: (e: unknown, count: number) => Promise<void> | void
  retries?: number
  signal?: AbortSignal
}

export async function retry<T = void>(
  callback: (count: number) => Promise<T | void> | T | void,
  { error, retries = 1, signal }: RetryOptions,
): Promise<T | void> {
  let count = 1

  while (count <= retries)
    try {
      signal?.throwIfAborted()

      return await callback(count)
    } catch (e) {
      signal?.throwIfAborted()

      await error?.(e, count)

      count += 1
    }
}
