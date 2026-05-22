import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, expect, test, vi } from "vitest"
import type { ReviewThread } from "../github/commands"
import type {
  EditOutput,
  Exec,
  MagiConfig,
  ResolvedRepository,
  RereviewOutput,
} from "../types"
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

const composeRereviewCloseReconsiderationPromptMock = vi.hoisted(() => vi.fn())
const composeRereviewPromptMock = vi.hoisted(() => vi.fn())
const runModelWithRepairMock = vi.hoisted(() => vi.fn())

vi.mock("../prompts/compose", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../prompts/compose")>()

  return {
    ...actual,
    composeRereviewCloseReconsiderationPrompt:
      composeRereviewCloseReconsiderationPromptMock,
    composeRereviewPrompt: composeRereviewPromptMock,
  }
})

vi.mock("./model", () => ({
  runModelWithRepair: runModelWithRepairMock,
}))

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

const mergeOutput = (): RereviewOutput => ({
  followUps: [],
  newFindings: [],
  resolve: [],
  verdict: "MERGE",
})

const closeOutput = (): RereviewOutput => ({
  followUps: [],
  newFindings: [],
  reason: "Out of scope.",
  resolve: [],
  verdict: "CLOSE",
})

const editOutput = (): EditOutput => ({
  commitMessage: "fix(merge): use dry-run head",
  commitSha: "dry-run-edited-head",
  filesTouched: ["src/orchestrator/merge.ts"],
  mode: "EDITED",
  responses: [],
})

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

beforeEach(() => {
  composeRereviewCloseReconsiderationPromptMock.mockReset()
  composeRereviewPromptMock.mockReset()
  runModelWithRepairMock.mockReset()
  runReviewMock.mockReset()

  composeRereviewCloseReconsiderationPromptMock.mockResolvedValue(
    "rereview close reconsideration prompt",
  )
  composeRereviewPromptMock.mockResolvedValue("rereview prompt")
})

describe("merge", () => {
  test("uses dry-run edited head for rereview close reconsideration prompts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "magi-merge-"))
    const reviewers = ["alpha", "bravo", "charlie"].map((key, index) => ({
      account: `${key}-bot`,
      index,
      key,
      model: "test/model",
      permission: "allow" as const,
    }))
    const mergeRepository: ResolvedRepository = {
      ...repository,
      agents: {
        editor: {
          account: "editor-bot",
          author: {
            email: "editor@example.com",
            name: "Editor Bot",
          },
          model: "test/editor",
          permission: "allow",
        },
        reviewers,
      },
    }
    const exec = vi.fn(async (command: string) => {
      if (command.startsWith("gh pr view")) {
        return JSON.stringify({
          baseRefName: "main",
          baseRefOid: "base-sha",
          headRefName: "feature",
          headRefOid: "original-head-sha",
          isDraft: false,
          number: 123,
          title: "Test PR",
          url: "https://github.example.com/owner/repo/pull/123",
        })
      }

      return ""
    })

    runReviewMock.mockResolvedValue({
      baseSha: "base-sha",
      ciReports: [],
      discardedFindings: [],
      headSha: "original-head-sha",
      outputs: {
        alpha: {
          findings: [
            {
              fix: "Fix the bug.",
              issue: "Bug remains.",
              line: 1,
              path: "file.ts",
            },
          ],
          verdict: "CHANGES_REQUESTED",
        },
        bravo: { findings: [], verdict: "MERGE" },
        charlie: { findings: [], verdict: "MERGE" },
      },
      posted: {},
      pr: 123,
      report: "",
      sessionIds: {},
      verdict: "CHANGES_REQUESTED",
      worktreePath: "/tmp/magi-review-worktree",
    })
    runModelWithRepairMock.mockImplementation(async (input) => {
      if (input.schemaName === "edit") {
        return { raw: "{}", sessionId: "editor-session", value: editOutput() }
      }
      if (input.schemaName === "rereview close reconsideration") {
        return {
          raw: "{}",
          sessionId: "charlie-session-2",
          value: mergeOutput(),
        }
      }

      return {
        raw: "{}",
        sessionId: `${input.title.includes("charlie") ? "charlie" : "reviewer"}-session`,
        value: input.title.includes("charlie") ? closeOutput() : mergeOutput(),
      }
    })

    await runMerge({
      client: { session: { create: vi.fn(), prompt: vi.fn() } },
      config: {},
      directory,
      dryRun: true,
      exec,
      pr: 123,
      repository: mergeRepository,
    })

    expect(composeRereviewCloseReconsiderationPromptMock).toHaveBeenCalledOnce()
    expect(
      composeRereviewCloseReconsiderationPromptMock.mock.calls[0]?.[0],
    ).toMatchObject({
      headSha: "dry-run-edited-head",
      previousHeadSha: "original-head-sha",
    })
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
    runModelWithRepairMock.mockImplementationOnce(async (input) => {
      prompts.push(input.prompt)
      throw new Error("stop after editor prompt")
    })

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
