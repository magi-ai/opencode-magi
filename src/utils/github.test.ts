import type { Exec } from "./exec"
import { createExecWithGitHubApiRetry, parseIssues, parsePrs } from "./github"

describe("parseIssues", () => {
  test("parses issue numbers, references, and URLs", () => {
    expect(
      parseIssues("12, #34 https://github.com/magi-ai/opencode-magi/issues/56"),
    ).toStrictEqual([12, 34, 56])
  })

  test("ignores values that do not end in an issue number", () => {
    expect(parseIssues("issue-twelve invalid #34-extra 56")).toStrictEqual([56])
  })

  test("throws when no issue numbers are present", () => {
    expect(() => parseIssues("invalid input")).toThrow(
      "Specify one or more issue numbers or issue URLs.",
    )
  })
})

describe("parsePrs", () => {
  test("parses PR numbers, references, and URLs", () => {
    expect(
      parsePrs("12, #34 https://github.com/magi-ai/opencode-magi/pull/56"),
    ).toStrictEqual([12, 34, 56])
  })

  test("stops parsing when command options begin", () => {
    expect(parsePrs("12 34 --merge 56 #78")).toStrictEqual([12, 34])
  })

  test("throws when no PR numbers are present", () => {
    expect(() => parsePrs("--merge 12")).toThrow(
      "Specify one or more PR numbers or PR URLs.",
    )
  })
})

describe("createExecWithGitHubApiRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test("returns successful command output without retrying", async () => {
    const exec = vi.fn<Exec>().mockResolvedValue("output")
    const retryingExec = createExecWithGitHubApiRetry(exec, 2)

    await expect(retryingExec("gh api repos/example")).resolves.toBe("output")
    expect(exec).toHaveBeenCalledExactlyOnceWith(
      "gh api repos/example",
      undefined,
    )
  })

  test.each([
    ["a non-GitHub command", "git status", new Error("rate limit exceeded")],
    [
      "an unsupported GitHub command",
      "gh issue list",
      new Error("rate limit exceeded"),
    ],
    ["a non-rate-limit error", "gh api repos/example", new Error("not found")],
    ["a primitive error", "gh api repos/example", "not found"],
  ])("propagates %s without retrying", async (_label, command, error) => {
    const exec = vi.fn<Exec>().mockRejectedValue(error)
    const retryingExec = createExecWithGitHubApiRetry(exec, 2)

    await expect(retryingExec(command)).rejects.toBe(error)
    expect(exec).toHaveBeenCalledExactlyOnceWith(command, undefined)
  })

  test("retries eligible commands with exponential backoff", async () => {
    const exec = vi
      .fn<Exec>()
      .mockRejectedValueOnce({ stderr: "API rate limit exceeded" })
      .mockRejectedValueOnce({ stdout: "RATE LIMIT" })
      .mockResolvedValue("output")
    const retryingExec = createExecWithGitHubApiRetry(exec, 2, 100)
    const result = retryingExec("prefix gh pr view 12")

    await vi.advanceTimersByTimeAsync(99)
    expect(exec).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(exec).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(199)
    expect(exec).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)

    await expect(result).resolves.toBe("output")
    expect(exec).toHaveBeenCalledTimes(3)
  })

  test("propagates the final error after retry attempts are exhausted", async () => {
    const firstError = new Error("rate limit first")
    const finalError = new Error("rate limit final")
    const exec = vi
      .fn<Exec>()
      .mockRejectedValueOnce(firstError)
      .mockRejectedValueOnce(finalError)
    const retryingExec = createExecWithGitHubApiRetry(exec, 1, 50)
    const result = retryingExec("gh auth status")

    void result.catch(() => undefined)

    await vi.advanceTimersByTimeAsync(50)

    await expect(result).rejects.toBe(finalError)
    expect(exec).toHaveBeenCalledTimes(2)
  })

  test("retries immediately when the delay is zero", async () => {
    const exec = vi
      .fn<Exec>()
      .mockRejectedValueOnce(new Error("rate limit exceeded"))
      .mockResolvedValue("output")
    const retryingExec = createExecWithGitHubApiRetry(exec, 1, 0)

    await expect(retryingExec("gh run view 12")).resolves.toBe("output")
    expect(exec).toHaveBeenCalledTimes(2)
  })

  test("aborts before waiting when the signal is already aborted", async () => {
    const exec = vi
      .fn<Exec>()
      .mockRejectedValue(new Error("rate limit exceeded"))
    const controller = new AbortController()

    controller.abort()

    const retryingExec = createExecWithGitHubApiRetry(exec, 1, 100)

    await expect(
      retryingExec("gh api repos/example", { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(exec).toHaveBeenCalledTimes(1)
  })

  test("aborts while waiting for the next retry", async () => {
    const exec = vi
      .fn<Exec>()
      .mockRejectedValue(new Error("rate limit exceeded"))
    const controller = new AbortController()
    const retryingExec = createExecWithGitHubApiRetry(exec, 1, 100)
    const result = retryingExec("gh api repos/example", {
      signal: controller.signal,
    })

    await vi.advanceTimersByTimeAsync(0)
    controller.abort()

    await expect(result).rejects.toMatchObject({ name: "AbortError" })
    expect(exec).toHaveBeenCalledTimes(1)
  })
})
