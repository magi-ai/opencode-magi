import { describe, expect, test } from "vitest"
import { withGitHubApiRetry } from "./retry"

describe("GitHub API retry", () => {
  test("retries GitHub commands that fail with rate limit errors", async () => {
    let calls = 0
    const exec = withGitHubApiRetry(
      async () => {
        calls += 1
        if (calls < 3) throw new Error("API rate limit exceeded")

        return "ok"
      },
      3,
      0,
    )

    await expect(exec("gh api repos/owner/repo")).resolves.toBe("ok")
    expect(calls).toBe(3)
  })

  test("does not retry non-rate-limit GitHub command failures", async () => {
    let calls = 0
    const exec = withGitHubApiRetry(
      async () => {
        calls += 1
        throw new Error("not found")
      },
      3,
      0,
    )

    await expect(exec("gh api repos/owner/repo")).rejects.toThrow("not found")
    expect(calls).toBe(1)
  })

  test("does not retry non-GitHub commands", async () => {
    let calls = 0
    const exec = withGitHubApiRetry(
      async () => {
        calls += 1
        throw new Error("rate limit")
      },
      3,
      0,
    )

    await expect(exec("git status")).rejects.toThrow("rate limit")
    expect(calls).toBe(1)
  })
})
