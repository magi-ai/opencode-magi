import { describe, expect, test } from "vitest"
import type { ReviewThread } from "../github/commands"
import {
  blockingReviewFindings,
  editableReviewThreads,
  exhaustedReviewThreads,
  hasBlockingCiReports,
  incrementReviewThreadAttempts,
  recordReviewThreads,
  reviewThreadNotification,
  runMerge,
  type ThreadResolutionAttempt,
} from "./merge"
import type { ModelClient } from "./model"
import type { ResolvedRepository } from "../types"

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
    host: "github.example.com",
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

function thread(threadId: string): ReviewThread {
  return {
    body: `body ${threadId}`,
    commentId: Number(threadId.replace(/\D/g, "")) || 1,
    comments: [
      {
        author: "bot-a",
        body: `body ${threadId}`,
        commentId: Number(threadId.replace(/\D/g, "")) || 1,
        createdAt: "2026-01-01T00:00:00Z",
      },
    ],
    line: 1,
    path: "file.ts",
    threadId,
  }
}

describe("merge", () => {
  test("reports the merge.editor config key when editor is missing", async () => {
    const client: ModelClient = {
      session: {
        create: async () => ({ id: "session" }),
        prompt: async () => ({}),
      },
    }

    await expect(
      runMerge({
        client,
        config: {},
        directory: ".",
        exec: async () => "",
        pr: 7557,
        repository,
      }),
    ).rejects.toThrow("merge.editor is required for magi_merge")
  })

  test("treats maxThreadResolutionCycles 0 as unlimited per thread", () => {
    const attempts: Record<string, ThreadResolutionAttempt> = {}
    const threads = [thread("thread-1")]

    recordReviewThreads({ attempts, cycle: 1, threads })
    incrementReviewThreadAttempts({
      attempts,
      cycle: 1,
      maxThreadResolutionCycles: 0,
      threads,
    })
    incrementReviewThreadAttempts({
      attempts,
      cycle: 100,
      maxThreadResolutionCycles: 0,
      threads,
    })

    expect(
      editableReviewThreads({
        attempts,
        maxThreadResolutionCycles: 0,
        threads,
      }),
    ).toEqual(threads)
    expect(
      exhaustedReviewThreads({
        attempts,
        maxThreadResolutionCycles: 0,
        threads,
      }),
    ).toEqual([])
  })

  test("limits resolution attempts independently per review thread", () => {
    const attempts: Record<string, ThreadResolutionAttempt> = {}
    const threadA = thread("thread-1")
    const threadB = thread("thread-2")

    recordReviewThreads({ attempts, cycle: 1, threads: [threadA] })
    incrementReviewThreadAttempts({
      attempts,
      cycle: 1,
      maxThreadResolutionCycles: 3,
      threads: [threadA],
    })
    incrementReviewThreadAttempts({
      attempts,
      cycle: 2,
      maxThreadResolutionCycles: 3,
      threads: [threadA],
    })
    incrementReviewThreadAttempts({
      attempts,
      cycle: 3,
      maxThreadResolutionCycles: 3,
      threads: [threadA],
    })
    recordReviewThreads({ attempts, cycle: 4, threads: [threadA, threadB] })

    expect(
      editableReviewThreads({
        attempts,
        maxThreadResolutionCycles: 3,
        threads: [threadA, threadB],
      }),
    ).toEqual([threadB])
    expect(
      exhaustedReviewThreads({
        attempts,
        maxThreadResolutionCycles: 3,
        threads: [threadA, threadB],
      }),
    ).toEqual([threadA])
    expect(attempts["thread-1"]?.exhaustedAtCycle).toBe(3)
    expect(attempts["thread-2"]?.attempts).toBe(0)
  })

  test("uses configured GitHub host in review thread notifications", () => {
    expect(
      reviewThreadNotification(repository, 7557, thread("thread-123")),
    ).toEqual({
      label: "GitHub thread",
      url: "https://github.example.com/owner/repo/pull/7557#discussion_r123",
    })
  })

  test("extracts inline findings for the editor", () => {
    expect(
      blockingReviewFindings({
        alpha: {
          findings: [
            {
              fix: "Pass findings to the editor.",
              issue: "Inline findings are lost.",
              line: 25,
              path: "src/orchestrator/merge.ts",
            },
          ],
          verdict: "CHANGES_REQUESTED",
        },
      }),
    ).toEqual([
      {
        fix: "Pass findings to the editor.",
        issue: "Inline findings are lost.",
        line: 25,
        path: "src/orchestrator/merge.ts",
        reviewer: "alpha",
        type: "inline",
      },
    ])
  })

  test("treats scope-in CI failures as merge blocking", () => {
    expect(
      hasBlockingCiReports([
        {
          attempts: 0,
          excluded: [],
          failed: [],
          rerun: [],
          scopeInside: [
            {
              check: {
                bucket: "fail",
                link: "https://github.com/owner/repo/actions/runs/1/job/123",
                name: "Test",
                state: "FAILURE",
                workflow: "CI",
              },
              classification: "SCOPE_IN",
              reason: "Changed code failed.",
            },
          ],
          scopeOutsideRecovered: [],
          scopeOutsideUnresolved: [],
        },
      ]),
    ).toBe(true)
  })
})
