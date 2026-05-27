import type { PullRequestSafetyMeta } from "../github/commands"
import type { ResolvedRepository } from "../types"
import { describe, expect, test } from "vitest"
import { evaluateSafetyGate } from "./safety"

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
    approvalPolicy: "majority",
    auto: true,
    deleteBranch: true,
    maxThreadResolutionCycles: 5,
    mergeQueue: false,
    method: "squash",
  },
  mode: "multi",
  prompts: {},
  safety: {
    allowAuthors: ["trusted"],
    blockedPaths: [".github/**", "infra/**"],
    maxChangedFiles: 2,
    requiredLabels: ["magi-ok"],
  },
}

const meta: PullRequestSafetyMeta = {
  author: "trusted",
  changedFiles: 1,
  files: ["src/app.ts"],
  labels: ["magi-ok"],
}

describe("safety gate", () => {
  test("passes when all constraints are satisfied", () => {
    expect(evaluateSafetyGate(repository, meta)).toMatchObject({ ok: true })
  })

  test("blocks risky pull requests", () => {
    const result = evaluateSafetyGate(repository, {
      author: "external",
      changedFiles: 3,
      files: [".github/workflows/quality.yml"],
      labels: [],
    })

    expect(result.ok).toBe(false)
    expect(result.reasons).toContain("Missing required labels: magi-ok")
    expect(result.reasons).toContain("PR author is not allowed: external")
    expect(result.reasons).toContain("Changed files exceed safety limit: 3 > 2")
    expect(result.reasons).toContain(
      "Blocked paths changed: .github/workflows/quality.yml",
    )
  })
})
