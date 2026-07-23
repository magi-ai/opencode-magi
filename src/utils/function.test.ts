import { describe, expect, it } from "vitest"
import { ignoreError } from "./function"

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
