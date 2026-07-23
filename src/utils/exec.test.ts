import { beforeEach, describe, expect, test, vi } from "vitest"
import { createExec, execAsync } from "./exec"

const { execAsyncMock } = vi.hoisted(() => ({ execAsyncMock: vi.fn() }))

vi.mock("node:util", () => ({
  promisify: (): typeof execAsyncMock => execAsyncMock,
}))

describe("execAsync", () => {
  beforeEach(() => {
    execAsyncMock.mockReset()
  })

  test("returns the promisified exec result", async () => {
    const result = { stderr: "warning", stdout: "output" }

    execAsyncMock.mockResolvedValue(result)

    await expect(execAsync("command")).resolves.toBe(result)
    expect(execAsyncMock).toHaveBeenCalledExactlyOnceWith("command")
  })

  test("propagates execution errors", async () => {
    const error = new Error("execution failed")

    execAsyncMock.mockRejectedValue(error)

    await expect(execAsync("command")).rejects.toBe(error)
  })
})

describe("createExec", () => {
  beforeEach(() => {
    execAsyncMock.mockReset()
  })

  test("uses the default directory and trims stdout", async () => {
    execAsyncMock.mockResolvedValue({ stderr: "", stdout: "  output\n" })

    const exec = createExec("/default")

    await expect(exec("command")).resolves.toBe("output")
    expect(execAsyncMock).toHaveBeenCalledExactlyOnceWith("command", {
      cwd: "/default",
      env: process.env,
      maxBuffer: 1024 * 1024 * 20,
      signal: undefined,
    })
  })

  test("forwards directory, environment, and abort signal overrides", async () => {
    execAsyncMock.mockResolvedValue({ stderr: "", stdout: "output" })

    const controller = new AbortController()
    const exec = createExec("/default")

    await exec("command", {
      cwd: "/override",
      env: { TEST_EXEC_VALUE: "value" },
      signal: controller.signal,
    })

    expect(execAsyncMock).toHaveBeenCalledExactlyOnceWith("command", {
      cwd: "/override",
      env: { ...process.env, TEST_EXEC_VALUE: "value" },
      maxBuffer: 1024 * 1024 * 20,
      signal: controller.signal,
    })
  })

  test("propagates execution errors", async () => {
    const error = new Error("execution failed")

    execAsyncMock.mockRejectedValue(error)

    await expect(createExec("/default")("command")).rejects.toBe(error)
  })
})
