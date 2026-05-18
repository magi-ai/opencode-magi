export async function mapPool<T, U>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<U>,
  options: { signal?: AbortSignal } = {},
): Promise<U[]> {
  const concurrency = Math.max(1, Math.floor(limit))
  const results = Array.from<U>({ length: items.length })
  let nextIndex = 0

  async function runWorker(): Promise<void> {
    while (nextIndex < items.length) {
      options.signal?.throwIfAborted()

      const index = nextIndex

      nextIndex += 1
      results[index] = await worker(items[index], index)
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () =>
      runWorker(),
    ),
  )

  return results
}
