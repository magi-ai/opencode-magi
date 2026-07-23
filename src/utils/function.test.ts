import { afterEach, describe, expect, test, vi } from "vitest"
import { ignoreError, loop, retry, wait } from "./function"

describe("wait", () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  test("resolves after the requested delay and removes the abort listener", async () => {
    vi.useFakeTimers()

    const controller = new AbortController()
    const removeEventListener = vi.spyOn(
      controller.signal,
      "removeEventListener",
    )
    const result = wait(100, controller.signal)

    await vi.advanceTimersByTimeAsync(99)
    expect(removeEventListener).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    await expect(result).resolves.toBeUndefined()
    expect(removeEventListener).toHaveBeenCalledWith(
      "abort",
      expect.any(Function),
    )
  })

  test("rejects with the reason when aborted while waiting", async () => {
    vi.useFakeTimers()

    const controller = new AbortController()
    const reason = new Error("cancelled")
    const result = wait(100, controller.signal)

    controller.abort(reason)

    await expect(result).rejects.toBe(reason)
    expect(vi.getTimerCount()).toBe(0)
  })

  test("throws the reason when the signal is already aborted", () => {
    const controller = new AbortController()
    const reason = new Error("already cancelled")

    controller.abort(reason)

    expect(() => wait(100, controller.signal)).toThrow(reason)
  })
})

describe("loop", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  test("repeats synchronous and asynchronous nullish results until a value is returned", async () => {
    vi.useFakeTimers()

    const callback = vi
      .fn()
      .mockReturnValueOnce(undefined)
      .mockResolvedValueOnce(null)
      .mockReturnValueOnce("complete")
    const result = loop(callback, 100)

    await vi.runAllTimersAsync()

    await expect(result).resolves.toBe("complete")
    expect(callback).toHaveBeenCalledTimes(3)
  })

  test("propagates callback errors", async () => {
    const error = new Error("failed")

    await expect(
      loop(() => {
        throw error
      }),
    ).rejects.toBe(error)
  })
})

describe("retry", () => {
  test("returns the first successful result with the attempt context", async () => {
    const callback = vi.fn().mockReturnValue("complete")

    await expect(retry(callback, { retries: 3 })).resolves.toBe("complete")
    expect(callback).toHaveBeenCalledExactlyOnceWith(1, undefined)
  })

  test("reports failures and passes the previous error to the next attempt", async () => {
    const firstError = new Error("first")
    const secondError = new Error("second")
    const callback = vi
      .fn()
      .mockRejectedValueOnce(firstError)
      .mockImplementationOnce(() => {
        throw secondError
      })
      .mockResolvedValueOnce("complete")
    const onError = vi.fn().mockResolvedValue(undefined)

    await expect(retry(callback, { error: onError, retries: 3 })).resolves.toBe(
      "complete",
    )
    expect(callback).toHaveBeenNthCalledWith(1, 1, undefined)
    expect(callback).toHaveBeenNthCalledWith(2, 2, firstError)
    expect(callback).toHaveBeenNthCalledWith(3, 3, secondError)
    expect(onError).toHaveBeenNthCalledWith(1, firstError, 1)
    expect(onError).toHaveBeenNthCalledWith(2, secondError, 2)
  })

  test("resolves undefined after all attempts fail", async () => {
    const error = new Error("failed")
    const callback = vi.fn().mockRejectedValue(error)

    await expect(retry(callback, { retries: 2 })).resolves.toBeUndefined()
    expect(callback).toHaveBeenCalledTimes(2)
  })

  test("propagates error callback failures", async () => {
    const callbackError = new Error("callback failed")
    const errorCallbackError = new Error("error callback failed")

    await expect(
      retry(
        () => {
          throw callbackError
        },
        {
          error: () => {
            throw errorCallbackError
          },
          retries: 2,
        },
      ),
    ).rejects.toBe(errorCallbackError)
  })

  test("propagates an existing abort without running the callback", async () => {
    const controller = new AbortController()
    const reason = new Error("cancelled")
    const callback = vi.fn()

    controller.abort(reason)

    await expect(
      retry(callback, { retries: 2, signal: controller.signal }),
    ).rejects.toBe(reason)
    expect(callback).not.toHaveBeenCalled()
  })

  test("prefers an abort reason over a callback error", async () => {
    const controller = new AbortController()
    const reason = new Error("cancelled")
    const onError = vi.fn()

    await expect(
      retry(
        () => {
          controller.abort(reason)

          throw new Error("failed")
        },
        { error: onError, retries: 2, signal: controller.signal },
      ),
    ).rejects.toBe(reason)
    expect(onError).not.toHaveBeenCalled()
  })
})

describe("ignoreError", () => {
  test("returns undefined when the error matches the callback", async () => {
    const error = new Error("expected")

    await expect(
      ignoreError(
        () => Promise.reject(error),
        (e) => e === error,
      ),
    ).resolves.toBeUndefined()
  })

  test("rethrows errors that do not match the callback", async () => {
    const error = new Error("unexpected")

    await expect(
      ignoreError(
        () => Promise.reject(error),
        () => false,
      ),
    ).rejects.toThrow(error)
  })
})
