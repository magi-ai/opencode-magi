import { describe, expect, test, vi } from "vitest"
import { Worker } from "./worker"

interface Deferred<T> {
  promise: Promise<T>
  reject: (error: unknown) => void
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let reject!: (error: unknown) => void
  let resolve!: (value: T) => void

  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    reject = promiseReject
    resolve = promiseResolve
  })

  return { promise, reject, resolve }
}

describe("Worker.run", () => {
  test("runs up to the concurrency limit and starts queued tasks in FIFO order", async () => {
    const worker = new Worker<string>(2)
    const first = deferred<string>()
    const second = deferred<string>()
    const third = deferred<string>()
    const fourth = deferred<string>()
    const started: string[] = []
    const firstResult = worker.run(() => {
      started.push("first")

      return first.promise
    })
    const secondResult = worker.run(() => {
      started.push("second")

      return second.promise
    })
    const thirdResult = worker.run(() => {
      started.push("third")

      return third.promise
    })
    const fourthResult = worker.run(() => {
      started.push("fourth")

      return fourth.promise
    })

    expect(started).toStrictEqual(["first", "second"])

    second.resolve("second result")
    await expect(secondResult).resolves.toBe("second result")
    await Promise.resolve()
    expect(started).toStrictEqual(["first", "second", "third"])

    first.resolve("first result")
    await expect(firstResult).resolves.toBe("first result")
    await Promise.resolve()
    expect(started).toStrictEqual(["first", "second", "third", "fourth"])

    third.resolve("third result")
    fourth.resolve("fourth result")
    await expect(thirdResult).resolves.toBe("third result")
    await expect(fourthResult).resolves.toBe("fourth result")
  })

  test("normalizes fractional and non-positive limits to one active task", async () => {
    const worker = new Worker<void>(0.5)
    const first = deferred<void>()
    const second = vi.fn().mockResolvedValue(undefined)
    const firstResult = worker.run(() => first.promise)
    const secondResult = worker.run(second)

    expect(second).not.toHaveBeenCalled()

    first.resolve(undefined)
    await firstResult
    await Promise.resolve()
    await expect(secondResult).resolves.toBeUndefined()
    expect(second).toHaveBeenCalledOnce()
  })

  test("continues with the next queued task after a rejection", async () => {
    const worker = new Worker<string>(1)
    const first = deferred<string>()
    const error = new Error("failed")
    const second = vi.fn().mockResolvedValue("complete")
    const firstResult = worker.run(() => first.promise)
    const secondResult = worker.run(second)

    void firstResult.catch(() => undefined)

    expect(second).not.toHaveBeenCalled()

    first.reject(error)
    await expect(firstResult).rejects.toBe(error)
    await Promise.resolve()
    await expect(secondResult).resolves.toBe("complete")
    expect(second).toHaveBeenCalledOnce()
  })
})
