import type { ResolvedRepository } from "../types"
import { describe, expect, test } from "vitest"
import { extractFailureEvidence, waitForChecksWithClassification } from "./ci"

const repository: ResolvedRepository = {
  agents: { reviewers: [] },
  alias: "repo",
  automation: { close: true, merge: true },
  checks: {
    exclude: [],
    retryFailedJobs: 3,
    waitAfterEdit: true,
    waitBeforeReview: true,
  },
  concurrency: { runs: 3, reviewers: 3 },
  github: {
    apiRetryAttempts: 3,
    host: "github.com",
    owner: "owner",
    repo: "repo",
  },
  merge: {
    auto: true,
    approvalPolicy: "majority",
    deleteBranch: true,
    maxThreadResolutionCycles: 5,
    mergeQueue: false,
    method: "squash",
  },
  prompts: {},
  safety: { allowAuthors: [], blockedPaths: [], requiredLabels: [] },
}

function reviewer(
  overrides: Partial<ResolvedRepository["agents"]["reviewers"][number]> = {},
): ResolvedRepository["agents"]["reviewers"][number] {
  return {
    account: "bot",
    index: 0,
    key: "reviewer-1",
    model: "openai/gpt",
    permission: { read: "allow" },
    ...overrides,
  }
}

function check(
  overrides: Partial<{
    bucket: string
    link: string
    name: string
    state: string
    workflow: string
  }> = {},
) {
  return {
    bucket: "fail",
    link: "https://github.com/owner/repo/actions/runs/1/job/123",
    name: "Test",
    state: "FAILURE",
    workflow: "CI",
    ...overrides,
  }
}

function classifierClient(input: {
  checks?: {
    classification: "SCOPE_IN" | "SCOPE_OUT"
    name: string
    reason: string
  }[]
  classification?: "SCOPE_IN" | "SCOPE_OUT"
  reason?: string
}) {
  return {
    session: {
      create: async () => ({ id: "session" }),
      prompt: async () => ({
        info: {
          text: JSON.stringify({
            checks: input.checks ?? [
              {
                classification: input.classification,
                name: "Test",
                reason: input.reason,
              },
            ],
          }),
        },
      }),
    },
  }
}

function expectNoRunRerun(commands: string[]) {
  expect(commands.some((command) => command.includes("gh run rerun"))).toBe(
    false,
  )
}

describe("check handling", () => {
  test("extracts structured evidence from repeated failure logs", () => {
    const evidence = extractFailureEvidence(
      [
        "FAIL jsdom src/components/modal/modal.test.tsx > <Modal /> > sets aria attributes correctly",
        "RangeError: Maximum call stack size exceeded",
        " \u276f src/core/css/css.ts:169:20",
        " \u276f createCSS src/core/css/css.ts:252:35",
        " \u276f createCSS src/core/css/css.ts:271:35",
        " \u276f createCSS src/core/css/css.ts:271:35",
      ].join("\n"),
    )

    expect(evidence.errorMessages).toContain(
      "RangeError: Maximum call stack size exceeded",
    )
    expect(evidence.failingFiles).toContain(
      "src/components/modal/modal.test.tsx",
    )
    expect(evidence.relevantFrames).toContain(
      "\u276f createCSS src/core/css/css.ts:271:35 (repeated 2 times)",
    )
    expect(evidence.representativeLog).toContain("RangeError")
  })

  test("excludes configured failed checks before classification", async () => {
    let promptCount = 0
    const failed = [
      {
        bucket: "fail",
        link: "https://github.com/owner/repo/actions/runs/1/job/123",
        name: "Vercel Preview Comments",
        state: "FAILURE",
        workflow: "",
      },
      {
        bucket: "fail",
        link: "https://github.com/owner/repo/actions/runs/1/job/456",
        name: "Test / React - Chromium 4/4",
        state: "FAILURE",
        workflow: "Quality",
      },
    ]

    const result = await waitForChecksWithClassification({
      client: {
        session: {
          create: async () => ({ id: "session" }),
          prompt: async () => {
            promptCount += 1
            return { info: { text: JSON.stringify({ checks: [] }) } }
          },
        },
      },
      directory: ".",
      exec: async (command) => {
        if (command.includes("--watch")) throw new Error("checks failed")
        if (command.includes("--json")) return JSON.stringify(failed)

        return ""
      },
      pr: 1,
      repairAttempts: 0,
      wait: true,
      repository: {
        ...repository,
        checks: {
          ...repository.checks,
          exclude: ["Vercel Preview Comments", "/^Test \\/ React - .* 4\\/4$/"],
        },
      },
    })

    expect(promptCount).toBe(0)
    expect(result?.report.failed).toEqual([])
    expect(result?.report.excluded).toEqual(failed)
    expect(result?.ciFailureContext).toBe("")
  })

  test("reruns scope-out failed GitHub Actions jobs", async () => {
    let watches = 0
    let jsonCalls = 0
    const commands: string[] = []
    const failed = [check()]

    const result = await waitForChecksWithClassification({
      client: classifierClient({
        classification: "SCOPE_OUT",
        reason: "Flaky browser test.",
      }),
      directory: ".",
      exec: async (command) => {
        commands.push(command)

        if (command.includes("--watch")) {
          watches += 1
          if (watches === 1) throw new Error("checks failed")
          return ""
        }

        if (command.includes("--json")) {
          jsonCalls += 1
          return JSON.stringify(jsonCalls === 1 ? failed : [])
        }
        if (command.includes("--log-failed")) return "flaky timeout"

        return ""
      },
      pr: 1,
      repairAttempts: 0,
      wait: true,
      repository: {
        ...repository,
        agents: {
          reviewers: [reviewer()],
        },
      },
    })

    expect(result?.report.attempts).toBe(1)
    expect(result?.report.failed).toEqual([])
    expect(result?.report.scopeOutsideRecovered).toMatchObject([
      { check: failed[0], classification: "SCOPE_OUT" },
    ])
    expect(commands).toContain("gh run rerun --repo 'owner/repo' --job '123'")
    expect(commands).toContain(
      "gh run watch '1' --repo 'owner/repo' --exit-status",
    )
  })

  test("does not rerun scope-out jobs during dry runs", async () => {
    const commands: string[] = []
    const failed = [check()]

    const result = await waitForChecksWithClassification({
      client: classifierClient({
        classification: "SCOPE_OUT",
        reason: "Flaky browser test.",
      }),
      directory: ".",
      dryRun: true,
      exec: async (command) => {
        commands.push(command)
        if (command.includes("--watch")) throw new Error("checks failed")
        if (command.includes("--json")) return JSON.stringify(failed)
        if (command.includes("--log-failed")) return "flaky timeout"

        return ""
      },
      pr: 1,
      repairAttempts: 0,
      wait: true,
      repository: {
        ...repository,
        agents: { reviewers: [reviewer()] },
      },
    })

    expect(result?.report.dryRunRerun).toMatchObject([
      { check: failed[0], classification: "SCOPE_OUT" },
    ])
    expectNoRunRerun(commands)
  })

  test("does not report failed CI investigation while checks are pending", async () => {
    let checksCalls = 0
    const progress: string[] = []
    const pending = {
      bucket: "pending",
      link: "https://github.com/owner/repo/actions/runs/1/job/123",
      name: "Test",
      state: "IN_PROGRESS",
      workflow: "CI",
    }
    const passed = { ...pending, bucket: "pass", state: "SUCCESS" }

    const result = await waitForChecksWithClassification({
      client: {
        session: {
          create: async () => ({ id: "session" }),
          prompt: async () => ({
            info: { text: JSON.stringify({ checks: [] }) },
          }),
        },
      },
      directory: ".",
      exec: async (command) => {
        if (command.includes("--watch")) throw new Error("checks pending")
        if (command.includes("--json")) {
          checksCalls += 1
          return JSON.stringify(checksCalls === 1 ? [pending] : [passed])
        }

        return ""
      },
      onProgress: (phase) => {
        progress.push(phase)
      },
      pr: 1,
      repairAttempts: 0,
      repository,
      wait: true,
      waitPollIntervalMs: 0,
    })

    expect(result?.report.failed).toEqual([])
    expect(progress).not.toContain("investigating failed CI checks")
    expect(progress).toContain("CI checks passed")
  })

  test("classifies existing failures without waiting when wait is false", async () => {
    const commands: string[] = []
    const failed = [check()]

    const result = await waitForChecksWithClassification({
      client: classifierClient({
        classification: "SCOPE_IN",
        reason: "Type error in changed package.",
      }),
      directory: ".",
      exec: async (command) => {
        commands.push(command)

        if (command.includes("--watch")) throw new Error("should not wait")
        if (command.includes("--json")) return JSON.stringify(failed)
        if (command.includes("--log-failed")) return "Type error"

        return ""
      },
      pr: 1,
      repairAttempts: 0,
      repository: {
        ...repository,
        agents: {
          reviewers: [reviewer()],
        },
      },
      wait: false,
    })

    expect(result?.report.scopeInside).toMatchObject([
      { check: failed[0], classification: "SCOPE_IN" },
    ])
    expect(result?.ciFailureContext).toContain("Type error")
    expect(result?.ciFailureContext).toContain("Classifier reason")
    expect(commands.some((command) => command.includes("--watch"))).toBe(false)
  })

  test("records every check returned by a classifier run", async () => {
    const failed = [
      check({
        link: "https://github.com/owner/repo/actions/runs/1/job/123",
        name: "Unit Tests",
      }),
      check({
        link: "https://github.com/owner/repo/actions/runs/1/job/456",
        name: "Browser Tests",
      }),
    ]
    const progress: unknown[] = []

    const result = await waitForChecksWithClassification({
      client: classifierClient({
        checks: [
          {
            classification: "SCOPE_IN",
            name: "Unit Tests",
            reason: "Type error in changed code.",
          },
          {
            classification: "SCOPE_OUT",
            name: "Browser Tests",
            reason: "Unrelated flaky browser timeout.",
          },
        ],
      }),
      directory: ".",
      exec: async (command) => {
        if (command.includes("--watch")) throw new Error("checks failed")
        if (command.includes("--json")) return JSON.stringify(failed)
        if (command.includes("--log-failed")) return "failure log"

        return ""
      },
      onClassifierProgress: (event) => {
        progress.push(event)
      },
      pr: 1,
      repairAttempts: 0,
      repository: {
        ...repository,
        checks: { ...repository.checks, retryFailedJobs: 0 },
        agents: { reviewers: [reviewer()] },
      },
      wait: false,
    })

    expect(result?.report.classifierRuns).toMatchObject([
      {
        checks: [
          {
            classification: "SCOPE_IN",
            name: "Unit Tests",
            reason: "Type error in changed code.",
          },
          {
            classification: "SCOPE_OUT",
            name: "Browser Tests",
            reason: "Unrelated flaky browser timeout.",
          },
        ],
      },
    ])
    expect(progress).toContainEqual(
      expect.objectContaining({
        checks: [
          {
            classification: "SCOPE_IN",
            name: "Unit Tests",
            reason: "Type error in changed code.",
          },
          {
            classification: "SCOPE_OUT",
            name: "Browser Tests",
            reason: "Unrelated flaky browser timeout.",
          },
        ],
        type: "classifier_completed",
      }),
    )
  })

  test("waits for checks from the target head instead of trusting old checks", async () => {
    let checksCalls = 0
    const commands: string[] = []
    const oldCheck = {
      bucket: "pass",
      link: "https://github.com/owner/repo/actions/runs/1/job/123",
      name: "Test",
      state: "SUCCESS",
      workflow: "CI",
    }
    const newFailure = {
      bucket: "fail",
      link: "https://github.com/owner/repo/actions/runs/2/job/456",
      name: "Test",
      state: "FAILURE",
      workflow: "CI",
    }

    const result = await waitForChecksWithClassification({
      client: {
        session: {
          create: async () => ({ id: "session" }),
          prompt: async () => ({
            info: {
              text: JSON.stringify({
                checks: [
                  {
                    classification: "SCOPE_IN",
                    name: "Test",
                    reason: "New head failure.",
                  },
                ],
              }),
            },
          }),
        },
      },
      directory: ".",
      exec: async (command) => {
        commands.push(command)

        if (command.includes("--watch")) return ""
        if (command.includes("actions/runs/1")) {
          return JSON.stringify({ head_sha: "old-head", status: "completed" })
        }
        if (command.includes("actions/runs/2")) {
          return JSON.stringify({ head_sha: "new-head", status: "completed" })
        }
        if (command.includes("--json")) {
          checksCalls += 1
          return JSON.stringify(checksCalls === 1 ? [oldCheck] : [newFailure])
        }
        if (command.includes("--log-failed")) return "new head failure"

        return ""
      },
      headSha: "new-head",
      pr: 1,
      repairAttempts: 0,
      repository: {
        ...repository,
        agents: {
          reviewers: [reviewer()],
        },
      },
      wait: true,
      waitPollIntervalMs: 0,
    })

    expect(checksCalls).toBe(2)
    expect(result?.report.scopeInside).toMatchObject([
      { check: newFailure, classification: "SCOPE_IN" },
    ])
    expect(result?.ciFailureContext).toContain("new head failure")
  })

  test("keeps polling when target-head checks are not reported yet", async () => {
    let checksCalls = 0
    const passed = {
      bucket: "pass",
      link: "https://github.com/owner/repo/actions/runs/2/job/456",
      name: "Test",
      state: "SUCCESS",
      workflow: "CI",
    }

    const result = await waitForChecksWithClassification({
      client: {
        session: {
          create: async () => ({ id: "session" }),
          prompt: async () => {
            throw new Error("passing checks should not be classified")
          },
        },
      },
      directory: ".",
      exec: async (command) => {
        if (command.includes("actions/runs/2")) {
          return JSON.stringify({ head_sha: "new-head", status: "completed" })
        }
        if (command.includes("--json")) {
          checksCalls += 1
          if (checksCalls === 1) {
            throw Object.assign(new Error("Command failed"), {
              stderr: "no checks reported on the 'feature-branch' branch",
            })
          }

          return JSON.stringify([passed])
        }

        return ""
      },
      headSha: "new-head",
      pr: 1,
      repairAttempts: 0,
      repository,
      wait: true,
      waitPollIntervalMs: 0,
    })

    expect(checksCalls).toBe(2)
    expect(result?.report.failed).toEqual([])
    expect(result?.ciFailureContext).toBe("")
  })

  test("ignores old-head failures when a target head is provided", async () => {
    const commands: string[] = []
    const oldFailure = {
      bucket: "fail",
      link: "https://github.com/owner/repo/actions/runs/1/job/123",
      name: "Test",
      state: "FAILURE",
      workflow: "CI",
    }

    const result = await waitForChecksWithClassification({
      client: {
        session: {
          create: async () => ({ id: "session" }),
          prompt: async () => {
            throw new Error("old-head failures should not be classified")
          },
        },
      },
      directory: ".",
      exec: async (command) => {
        commands.push(command)

        if (command.includes("actions/runs/1")) {
          return JSON.stringify({ head_sha: "old-head", status: "completed" })
        }
        if (command.includes("--json")) return JSON.stringify([oldFailure])

        return ""
      },
      headSha: "new-head",
      pr: 1,
      repairAttempts: 0,
      repository,
      wait: false,
    })

    expect(result?.report.failed).toEqual([])
    expect(result?.report.scopeInside).toEqual([])
    expect(result?.ciFailureContext).toBe("")
    expect(commands.some((command) => command.includes("--watch"))).toBe(false)
  })

  test("reruns cancelled GitHub Actions jobs without classification", async () => {
    let watches = 0
    let jsonCalls = 0
    let promptCount = 0
    const commands: string[] = []
    const cancelled = [check({ bucket: "cancel", state: "CANCELLED" })]

    const result = await waitForChecksWithClassification({
      client: {
        session: {
          create: async () => ({ id: "session" }),
          prompt: async () => {
            promptCount += 1
            return { info: { text: JSON.stringify({ checks: [] }) } }
          },
        },
      },
      directory: ".",
      exec: async (command) => {
        commands.push(command)

        if (command.includes("--watch")) {
          watches += 1
          if (watches === 1) throw new Error("checks failed")
          return ""
        }
        if (command.includes("--json")) {
          jsonCalls += 1
          return JSON.stringify(jsonCalls === 1 ? cancelled : [])
        }

        return ""
      },
      pr: 1,
      repairAttempts: 0,
      repository: {
        ...repository,
        agents: {
          reviewers: [reviewer()],
        },
      },
      wait: true,
    })

    expect(promptCount).toBe(0)
    expect(result?.report.attempts).toBe(1)
    expect(result?.report.scopeOutsideRecovered).toMatchObject([
      { check: cancelled[0], classification: "SCOPE_OUT" },
    ])
    expect(commands).toContain("gh run rerun --repo 'owner/repo' --job '123'")
  })

  test("leaves non-rerunnable cancelled checks unresolved", async () => {
    const commands: string[] = []
    const cancelled = [
      check({
        bucket: "cancel",
        link: "https://example.com/check",
        name: "External Check",
        state: "CANCELLED",
        workflow: "",
      }),
    ]

    const result = await waitForChecksWithClassification({
      client: {
        session: {
          create: async () => ({ id: "session" }),
          prompt: async () => ({
            info: { text: JSON.stringify({ checks: [] }) },
          }),
        },
      },
      directory: ".",
      exec: async (command) => {
        commands.push(command)

        if (command.includes("--json")) return JSON.stringify(cancelled)

        return ""
      },
      pr: 1,
      repairAttempts: 0,
      repository,
      wait: false,
    })

    expect(result?.report.attempts).toBe(0)
    expect(result?.report.scopeOutsideUnresolved).toMatchObject([
      { check: cancelled[0], classification: "SCOPE_OUT" },
    ])
    expectNoRunRerun(commands)
  })

  test("returns scope-in failure context without rerunning", async () => {
    const commands: string[] = []
    const failed = [check()]

    const result = await waitForChecksWithClassification({
      client: classifierClient({
        classification: "SCOPE_IN",
        reason: "Type error in changed package.",
      }),
      directory: ".",
      exec: async (command) => {
        commands.push(command)

        if (command.includes("--watch")) throw new Error("checks failed")
        if (command.includes("--json")) return JSON.stringify(failed)
        if (command.includes("--log-failed")) return "Type error"

        return ""
      },
      pr: 1,
      repairAttempts: 0,
      wait: true,
      repository: {
        ...repository,
        agents: {
          reviewers: [reviewer()],
        },
      },
    })

    expect(result?.report.scopeInside).toMatchObject([
      { check: failed[0], classification: "SCOPE_IN" },
    ])
    expect(result?.ciFailureContext).toContain("Type error")
    expectNoRunRerun(commands)
  })

  test("classifies CI scope by reviewer majority", async () => {
    let promptCount = 0
    const failed = [
      {
        bucket: "fail",
        link: "https://github.com/owner/repo/actions/runs/1/job/123",
        name: "Test",
        state: "FAILURE",
        workflow: "CI",
      },
    ]

    const result = await waitForChecksWithClassification({
      client: {
        session: {
          create: async () => ({ id: `session-${promptCount}` }),
          prompt: async () => {
            promptCount += 1

            return {
              info: {
                text: JSON.stringify({
                  checks: [
                    {
                      classification:
                        promptCount === 1 ? "SCOPE_IN" : "SCOPE_OUT",
                      name: "Test",
                      reason: `reason ${promptCount}`,
                    },
                  ],
                }),
              },
            }
          },
        },
      },
      directory: ".",
      exec: async (command) => {
        if (command.includes("--watch")) throw new Error("checks failed")
        if (command.includes("--json")) return JSON.stringify(failed)
        if (command.includes("--log-failed")) return "flaky timeout"

        return ""
      },
      pr: 1,
      repairAttempts: 0,
      wait: true,
      repository: {
        ...repository,
        checks: { ...repository.checks, retryFailedJobs: 0 },
        agents: {
          reviewers: [
            reviewer({ account: "a", key: "a" }),
            reviewer({ account: "b", index: 1, key: "b" }),
            reviewer({ account: "c", index: 2, key: "c" }),
          ],
        },
      },
    })

    expect(promptCount).toBe(3)
    expect(result?.report.scopeOutsideUnresolved).toMatchObject([
      { check: failed[0], classification: "SCOPE_OUT" },
    ])
    expect(result?.report.scopeInside).toEqual([])
  })

  test("retries classifier failures in a fresh session", async () => {
    let creates = 0
    let prompts = 0
    const failed = [
      {
        bucket: "fail",
        link: "https://github.com/owner/repo/actions/runs/1/job/123",
        name: "Test",
        state: "FAILURE",
        workflow: "CI",
      },
    ]

    const result = await waitForChecksWithClassification({
      client: {
        session: {
          create: async () => ({ id: `session-${++creates}` }),
          prompt: async () => {
            prompts += 1
            if (prompts === 1) return { parts: [] }

            return {
              info: {
                text: JSON.stringify({
                  checks: [
                    {
                      classification: "SCOPE_OUT",
                      name: "Test",
                      reason: "Transient browser timeout.",
                    },
                  ],
                }),
              },
            }
          },
        },
      },
      directory: ".",
      exec: async (command) => {
        if (command.includes("--watch")) throw new Error("checks failed")
        if (command.includes("--json")) return JSON.stringify(failed)
        if (command.includes("--log-failed")) return "timeout"

        return ""
      },
      pr: 1,
      repairAttempts: 0,
      wait: true,
      repository: {
        ...repository,
        checks: { ...repository.checks, retryFailedJobs: 0 },
        agents: {
          reviewers: [reviewer({ account: "a", key: "a" })],
        },
      },
    })

    expect(creates).toBe(2)
    expect(result?.report.scopeOutsideUnresolved).toMatchObject([
      { check: failed[0], classification: "SCOPE_OUT" },
    ])
    expect(result?.report.classifierRuns).toMatchObject([
      {
        checks: [
          {
            classification: "SCOPE_OUT",
            name: "Test",
            reason: "Transient browser timeout.",
          },
        ],
        reviewer: "a",
        sessionId: "session-2",
        status: "completed",
      },
    ])
  })

  test("does not convert classifier failures to scope-in", async () => {
    const failed = [
      {
        bucket: "fail",
        link: "https://github.com/owner/repo/actions/runs/1/job/123",
        name: "Test",
        state: "FAILURE",
        workflow: "CI",
      },
    ]

    await expect(
      waitForChecksWithClassification({
        client: {
          session: {
            create: async () => ({ id: "session" }),
            prompt: async () => ({ parts: [] }),
          },
        },
        directory: ".",
        exec: async (command) => {
          if (command.includes("--watch")) throw new Error("checks failed")
          if (command.includes("--json")) return JSON.stringify(failed)
          if (command.includes("--log-failed")) return "timeout"

          return ""
        },
        pr: 1,
        repairAttempts: 0,
        wait: true,
        repository: {
          ...repository,
          checks: { ...repository.checks, retryFailedJobs: 0 },
          agents: {
            reviewers: [reviewer({ account: "a", key: "a" })],
          },
        },
      }),
    ).rejects.toThrow("CI classification did not reach majority for Test")
  })
})
