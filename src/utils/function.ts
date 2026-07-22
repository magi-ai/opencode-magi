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
  cb: () => Promise<T | void> | T | void,
  ms = 0,
): Promise<T> {
  for (;;) {
    const value = await cb()

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
  cb: (count: number, error: unknown) => Promise<T | void> | T | void,
  { error: errorCb, retries = 1, signal }: RetryOptions,
): Promise<T | void> {
  let count = 1
  let error: unknown

  while (count <= retries)
    try {
      signal?.throwIfAborted()

      return await cb(count, error)
    } catch (e) {
      signal?.throwIfAborted()

      await errorCb?.(e, count)

      error = e
      count += 1
    }
}
