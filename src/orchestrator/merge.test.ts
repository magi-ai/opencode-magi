import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, expect, test, vi } from "vitest"
import type { ReviewThread } from "../github/commands"
import type { Exec, MagiConfig, ResolvedRepository } from "../types"
import type { ModelClient } from "./model"
import type { ReviewRunResult } from "./review"
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

const runReviewMock = vi.hoisted(() => vi.fn())

vi.mock("./review", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./review")>()

  return { ...actual, runReview: runReviewMock }
})

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

const editorRepository: ResolvedRepository = {
  ...repository,
  agents: {
    editor: {
      account: "editor-bot",
      author: {
        email: "editor@example.com",
        name: "Editor Bot",
      },
      model: "opencode/test",
      permission: {},
    },
    reviewers: [],
  },
}

const emptyThreads = JSON.stringify({
  data: {
    repository: {
      pullRequest: {
        reviewThreads: {
          nodes: [],
        },
      },
    },
  },
})

beforeEach(() => {
  vi.clearAllMocks()
})

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

  test("passes blocking review findings to the editor without unresolved threads", async () => {
    const directory = await mkdtemp(join(tmpdir(), "magi-merge-test-"))
    const config: MagiConfig = { review: { output: join(directory, "runs") } }
    const review: ReviewRunResult = {
      baseSha: "base",
      ciReports: [],
      discardedFindings: [],
      headSha: "head",
      outputs: {
        alpha: {
          findings: [
            {
              fix: "Pass findings to the editor.",
              issue: "Blocking findings were skipped.",
              line: 1162,
              path: "src/orchestrator/merge.ts",
            },
          ],
          verdict: "CHANGES_REQUESTED",
        },
      },
      posted: {},
      pr: 162,
      report: "review report",
      sessionIds: {},
      verdict: "CHANGES_REQUESTED",
      worktreePath: directory,
    }
    const prompts: string[] = []
    const exec: Exec = async (command) => {
      if (command.startsWith("gh api")) return emptyThreads

      return ""
    }
    const client: ModelClient = {
      session: {
        create: async () => ({ id: "editor-session" }),
        prompt: async (input) => {
          const parts = input.body.parts as Array<{
            text?: string
            type: string
          }>

          prompts.push(parts.map((part) => part.text ?? "").join("\n"))
          throw new Error("stop after editor prompt")
        },
      },
    }

    runReviewMock.mockResolvedValueOnce(review)

    await expect(
      runMerge({
        client,
        config,
        directory,
        exec,
        pr: 162,
        repository: editorRepository,
      }),
    ).rejects.toThrow("stop after editor prompt")

    expect(prompts.join("\n")).toContain('"reviewer": "alpha"')
    expect(prompts.join("\n")).toContain("Pass findings to the editor.")
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
