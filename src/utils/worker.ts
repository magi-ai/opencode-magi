export interface WorkerOptions {
  limit: number
  signal?: AbortSignal
}

export function worker<T, U>(items: T[], { limit, signal }: WorkerOptions) {
  const length = items.length
  const concurrency = Math.max(1, Math.floor(limit))
  const results = Array.from<U>({ length })

  return async function (run: (value: T, index: number) => Promise<U>) {
    let nextIndex = 0

    async function next(): Promise<void> {
      while (nextIndex < length) {
        signal?.throwIfAborted()

        const index = nextIndex

        nextIndex += 1

        results[index] = await run(items[index]!, index)
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(concurrency, length) }, next),
    )

    return results
  }
}
