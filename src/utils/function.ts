export const wait = async (ms = 0): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })

export interface RetryOptions {
  error?: (e: unknown, count: number) => void
  retries?: number
}

export async function retry<T = void>(
  callback: (count: number) => Promise<T | void> | T | void,
  { error, retries = 1 }: RetryOptions,
): Promise<T | void> {
  let count = 1

  while (count <= retries)
    try {
      return await callback(count)
    } catch (e) {
      error?.(e, count)

      count += 1
    }
}
