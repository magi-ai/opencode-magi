import type { ModelClient } from "./model"
import type { MagiRunState } from "./run-manager"
import type { ResolvedRepository } from "../types"
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test, vi } from "vitest"

const runReviewMock = vi.hoisted(() => vi.fn())

vi.mock("./review", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./review")>()

  return { ...actual, runReview: runReviewMock }
})

import { MagiRunManager } from "./run-manager"

describe("MagiRunManager notifications", () => {
  afterEach(() => {
    runReviewMock.mockReset()
  })

  function managerWithPromptCapture(directory = ".") {
    const actions: unknown[] = []
    const execCommands: string[] = []
    const prompts: unknown[] = []
    const client: ModelClient = {
      permission: {
        reply: async (input) => {
          actions.push({ input, type: "permission.reply" })

          return {}
        },
      },
      question: {
        reject: async (input) => {
          actions.push({ input, type: "question.reject" })

          return {}
        },
        reply: async (input) => {
          actions.push({ input, type: "question.reply" })

          return {}
        },
      },
      session: {
        create: async () => ({ id: "session" }),
        delete: async (input) => {
          actions.push({ input, type: "session.delete" })

          return true
        },
        prompt: async (input) => {
          if (input.path.id === "parent-session") prompts.push(input)

          return { info: { text: "{}" } }
        },
        promptAsync: async (input) => {
          prompts.push(input)

          return {}
        },
      },
    }
    const manager = new MagiRunManager({
      client,
      directory,
      exec: async (command) => {
        execCommands.push(command)

        return ""
      },
    })

    return { actions, execCommands, manager, prompts }
  }

  function sampleReviewState(outputDir: string): MagiRunState {
    return {
      command: "review",
      createdAt: "now",
      outputDir,
      parentSessionId: "parent-session",
      phase: "reviewing",
      pr: 7557,
      prUrl: "https://example.com/pull/7557",
      repository: "repo",
      reviewers: {
        security: {
          account: "bot-a",
          repairAttempts: 0,
          sessionId: "child-session",
          status: "running",
          toolCalls: 0,
        },
      },
      runId: "run",
      status: "running",
      updatedAt: "now",
    }
  }

  function sampleRepository(): ResolvedRepository {
    return {
      agents: {
        reviewers: [
          {
            account: "bot-a",
            index: 0,
            key: "security",
            model: "test-model",
            permission: "ask",
          },
        ],
      },
      alias: "repo",
      automation: { close: false, merge: false },
      checks: {
        exclude: [],
        retryFailedJobs: 0,
        waitAfterEdit: false,
        waitBeforeReview: false,
      },
      concurrency: { reviewers: 1, runs: 1 },
      github: {
        apiRetryAttempts: 3,
        host: "github.com",
        owner: "owner",
        repo: "repo",
      },
      merge: {
        approvalPolicy: "majority",
        auto: false,
        deleteBranch: true,
        maxThreadResolutionCycles: 3,
        mergeQueue: false,
        method: "squash",
      },
      prompts: {},
      safety: { allowAuthors: [], blockedPaths: [], requiredLabels: [] },
    }
  }

  async function withTrackedSession(
    callback: (input: {
      manager: MagiRunManager
      actions: unknown[]
      prompts: unknown[]
      state: MagiRunState
    }) => Promise<void>,
  ) {
    const { actions, manager, prompts } = managerWithPromptCapture()
    const directory = await mkdtemp(join(tmpdir(), "magi-run-"))
    const state = sampleReviewState(directory)
    const privateManager = manager as unknown as {
      active: Map<string, MagiRunState>
      sessionToRun: Map<string, { agent: string; runId: string }>
    }

    privateManager.active.set("run", state)
    privateManager.sessionToRun.set("child-session", {
      agent: "security",
      runId: "run",
    })

    try {
      await callback({ actions, manager, prompts, state })
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  }

  test("sends synthetic notifications as model-visible replies", async () => {
    let promptInput: unknown
    const client: ModelClient = {
      session: {
        create: async () => ({ id: "session" }),
        prompt: async () => ({ info: { text: "{}" } }),
        promptAsync: async (input) => {
          promptInput = input

          return {}
        },
      },
    }
    const manager = new MagiRunManager({
      client,
      directory: ".",
      exec: async () => "",
    })
    const notify = (
      manager as unknown as {
        notify(state: MagiRunState, text: string): Promise<void>
      }
    ).notify.bind(manager)

    await notify(
      {
        command: "review",
        createdAt: "now",
        outputDir: ".",
        parentSessionId: "parent-session",
        phase: "completed",
        pr: 7557,
        repository: "repo",
        reviewers: {},
        runId: "run",
        status: "completed",
        updatedAt: "now",
      },
      "Finished reviewing [#7557](https://example.com/pull/7557).",
    )

    expect(promptInput).toMatchObject({
      body: {
        parts: [
          {
            synthetic: true,
            text: "Finished reviewing [#7557](https://example.com/pull/7557).",
            type: "text",
          },
        ],
      },
      path: { id: "parent-session" },
    })
  })

  test("notifies reviewer failures", async () => {
    const { manager, prompts } = managerWithPromptCapture()
    const state: MagiRunState = {
      command: "review",
      createdAt: "now",
      outputDir: ".",
      parentSessionId: "parent-session",
      phase: "reviewing",
      pr: 7557,
      prUrl: "https://example.com/pull/7557",
      repository: "repo",
      reviewers: {
        security: {
          account: "bot-a",
          repairAttempts: 1,
          status: "repairing",
          toolCalls: 0,
        },
      },
      runId: "run",
      status: "running",
      updatedAt: "now",
    }
    const privateManager = manager as unknown as {
      active: Map<string, MagiRunState>
      applyReviewProgress(runId: string, progress: unknown): Promise<void>
    }

    privateManager.active.set("run", state)
    await privateManager.applyReviewProgress("run", {
      error: "Invalid JSON",
      reviewer: "security",
      type: "reviewer_failed",
    })

    expect(state.reviewers.security.status).toBe("failed")
    expect(prompts).toMatchObject([
      {
        body: {
          parts: [
            {
              synthetic: true,
              text: "**Reviewer security** failed reviewing [#7557](https://example.com/pull/7557) after 1 JSON regeneration attempt: Invalid JSON",
              type: "text",
            },
          ],
        },
        path: { id: "parent-session" },
      },
    ])
  })

  test("notifies editor failures", async () => {
    const { manager, prompts } = managerWithPromptCapture()
    const state: MagiRunState = {
      command: "merge",
      createdAt: "now",
      editor: {
        account: "bot-editor",
        repairAttempts: 1,
        status: "repairing",
        toolCalls: 0,
      },
      outputDir: ".",
      parentSessionId: "parent-session",
      phase: "editing cycle 1",
      pr: 7557,
      prUrl: "https://example.com/pull/7557",
      repository: "repo",
      reviewers: {},
      runId: "run",
      status: "running",
      updatedAt: "now",
    }
    const privateManager = manager as unknown as {
      active: Map<string, MagiRunState>
      applyMergeProgress(runId: string, progress: unknown): Promise<void>
    }

    privateManager.active.set("run", state)
    await privateManager.applyMergeProgress("run", {
      cycle: 1,
      error: "Invalid JSON",
      type: "editor_failed",
    })

    expect(state.editor?.status).toBe("failed")
    expect(prompts).toMatchObject([
      {
        body: {
          parts: [
            {
              synthetic: true,
              text: "**Editor** failed editing [#7557](https://example.com/pull/7557) after 1 JSON regeneration attempt: Invalid JSON",
              type: "text",
            },
          ],
        },
        path: { id: "parent-session" },
      },
    ])
  })

  test("notifies thread resolution attempt limits with links", async () => {
    const { manager, prompts } = managerWithPromptCapture()
    const state: MagiRunState = {
      command: "merge",
      createdAt: "now",
      editor: {
        account: "bot-editor",
        repairAttempts: 0,
        status: "running",
        toolCalls: 0,
      },
      outputDir: ".",
      parentSessionId: "parent-session",
      phase: "editing cycle 1",
      pr: 7557,
      prUrl: "https://example.com/pull/7557",
      repository: "repo",
      reviewers: {},
      runId: "run",
      status: "running",
      updatedAt: "now",
    }
    const privateManager = manager as unknown as {
      active: Map<string, MagiRunState>
      applyMergeProgress(runId: string, progress: unknown): Promise<void>
    }

    privateManager.active.set("run", state)
    await privateManager.applyMergeProgress("run", {
      threads: [
        {
          label: "GitHub thread",
          url: "https://github.com/owner/repo/pull/7557#discussion_r123",
        },
      ],
      type: "thread_limit_reached",
    })

    expect(prompts).toMatchObject([
      {
        body: {
          parts: [
            {
              synthetic: true,
              text: "Review thread [GitHub thread](https://github.com/owner/repo/pull/7557#discussion_r123) reached the resolution attempt limit for [#7557](https://example.com/pull/7557).",
              type: "text",
            },
          ],
        },
        path: { id: "parent-session" },
      },
    ])
  })

  test("does not treat pending tool parts as permission waits", async () => {
    await withTrackedSession(async ({ manager, prompts, state }) => {
      await manager.handleEvent({
        event: {
          properties: {
            part: {
              id: "part-1",
              sessionID: "child-session",
              state: { input: { filePath: "src/a.ts" }, status: "pending" },
              tool: "read",
              type: "tool",
            },
          },
          type: "message.part.updated",
        },
      })

      expect(state.reviewers.security.status).toBe("running")
      expect(state.reviewers.security.error).toBeUndefined()
      expect(state.reviewers.security.toolCalls).toBe(1)
      expect(prompts).toEqual([])
    })
  })

  test("does not persist duplicate high-frequency session events", async () => {
    await withTrackedSession(async ({ manager, state }) => {
      await manager.handleEvent({
        event: {
          properties: {
            part: {
              id: "part-1",
              sessionID: "child-session",
              state: { status: "pending" },
              tool: "read",
              type: "tool",
            },
          },
          type: "message.part.updated",
        },
      })
      const updatedAt = state.updatedAt
      const lastUpdate = state.reviewers.security.lastUpdate

      await manager.handleEvent({
        event: {
          properties: {
            part: {
              id: "part-1",
              sessionID: "child-session",
              state: { status: "pending" },
              tool: "read",
              type: "tool",
            },
          },
          type: "message.part.updated",
        },
      })

      expect(state.reviewers.security.toolCalls).toBe(1)
      expect(state.reviewers.security.lastUpdate).toBe(lastUpdate)
      expect(state.updatedAt).toBe(updatedAt)
    })
  })

  test("notifies real permission requests once", async () => {
    await withTrackedSession(async ({ manager, prompts, state }) => {
      const event = {
        properties: {
          id: "permission-1",
          permission: "read",
          sessionID: "child-session",
        },
        type: "permission.asked",
      }

      await manager.handleEvent({ event })
      await manager.handleEvent({ event })

      expect(state.reviewers.security.status).toBe("blocked")
      expect(state.reviewers.security.error).toBe(
        "Permission read is waiting for approval.",
      )
      expect(prompts).toHaveLength(1)
      expect(prompts[0]).toMatchObject({
        body: {
          parts: [
            {
              text: "Magi security is waiting for permission on [#7557](https://example.com/pull/7557): Permission read is waiting for approval.",
            },
          ],
        },
      })
    })
  })

  test("marks blocked agents running after permission replies", async () => {
    await withTrackedSession(async ({ manager, state }) => {
      state.reviewers.security.status = "blocked"

      await manager.handleEvent({
        event: {
          properties: {
            requestID: "permission-1",
            sessionID: "child-session",
          },
          type: "permission.replied",
        },
      })

      expect(state.reviewers.security.status).toBe("running")
    })
  })

  test("stores question requests and replies from parent tools", async () => {
    await withTrackedSession(async ({ actions, manager, prompts, state }) => {
      await manager.handleEvent({
        event: {
          properties: {
            id: "question-1",
            questions: [{ header: "Confirm", question: "Proceed?" }],
            sessionID: "child-session",
          },
          type: "question.asked",
        },
      })

      expect(state.status).toBe("blocked")
      expect(state.reviewers.security.status).toBe("blocked")
      expect(state.reviewers.security.pendingQuestion?.id).toBe("question-1")
      expect(prompts[0]).toMatchObject({
        body: {
          parts: [
            {
              text: "Magi security is waiting for a question answer on [#7557](https://example.com/pull/7557). Request: question-1.\nQuestion:\n1. Confirm: Proceed?",
            },
          ],
        },
      })

      const reply = await manager.replyQuestion({
        answers: ["Yes"],
        pr: 7557,
      })

      expect(reply).toBe("Replied to question request question-1 for security.")
      expect(actions).toMatchObject([
        {
          input: { answers: ["Yes"], requestID: "question-1" },
          type: "question.reply",
        },
      ])
      expect(state.status).toBe("running")
      expect(state.reviewers.security.status).toBe("running")
      expect(state.reviewers.security.pendingQuestion).toBeUndefined()
    })
  })

  test("stores question requests from pending question tool parts", async () => {
    await withTrackedSession(async ({ actions, manager, prompts, state }) => {
      await manager.handleEvent({
        event: {
          properties: {
            part: {
              callID: "call-1",
              id: "part-1",
              sessionID: "child-session",
              state: {
                input: {
                  questions: [
                    {
                      header: "Confirm",
                      options: [
                        { description: "Proceed", label: "Yes" },
                        { description: "Stop", label: "No" },
                      ],
                      question: "Proceed?",
                    },
                  ],
                },
                status: "pending",
              },
              tool: "question",
              type: "tool",
            },
          },
          type: "message.part.updated",
        },
      })

      expect(state.status).toBe("blocked")
      expect(state.reviewers.security.status).toBe("blocked")
      expect(state.reviewers.security.pendingQuestion?.id).toBe("part-1")
      expect(state.reviewers.security.pendingQuestion?.questions).toHaveLength(
        1,
      )
      expect(prompts[0]).toMatchObject({
        body: {
          parts: [
            {
              text: "Magi security is waiting for a question answer on [#7557](https://example.com/pull/7557). Request: part-1.\nQuestion:\n1. Confirm: Proceed? Options: Yes, No.",
            },
          ],
        },
      })

      const reply = await manager.replyQuestion({
        answers: ["Yes"],
        pr: 7557,
      })

      expect(reply).toBe("Replied to question request part-1 for security.")
      expect(actions).toMatchObject([
        {
          input: { answers: ["Yes"], requestID: "part-1" },
          type: "question.reply",
        },
      ])
      expect(state.status).toBe("running")
      expect(state.reviewers.security.status).toBe("running")
      expect(state.reviewers.security.pendingQuestion).toBeUndefined()
    })
  })

  test("updates pending question tool parts with real question request ids", async () => {
    await withTrackedSession(async ({ manager, prompts, state }) => {
      await manager.handleEvent({
        event: {
          properties: {
            part: {
              id: "part-1",
              sessionID: "child-session",
              state: {
                input: {
                  questions: [{ header: "Confirm", question: "Proceed?" }],
                },
                status: "pending",
              },
              tool: "question",
              type: "tool",
            },
          },
          type: "message.part.updated",
        },
      })
      await manager.handleEvent({
        event: {
          properties: {
            id: "question-1",
            questions: [{ header: "Confirm", question: "Proceed?" }],
            sessionID: "child-session",
          },
          type: "question.asked",
        },
      })

      expect(prompts).toHaveLength(1)
      expect(state.reviewers.security.pendingQuestion?.id).toBe("question-1")
    })
  })

  test("clears pending question tool parts after completion", async () => {
    await withTrackedSession(async ({ manager, state }) => {
      const part = {
        id: "part-1",
        sessionID: "child-session",
        state: {
          input: { questions: [{ header: "Confirm", question: "Proceed?" }] },
          status: "pending",
        },
        tool: "question",
        type: "tool",
      }

      await manager.handleEvent({
        event: {
          properties: { part },
          type: "message.part.updated",
        },
      })
      await manager.handleEvent({
        event: {
          properties: {
            part: { ...part, state: { ...part.state, status: "completed" } },
          },
          type: "message.part.updated",
        },
      })

      expect(state.status).toBe("running")
      expect(state.reviewers.security.status).toBe("running")
      expect(state.reviewers.security.pendingQuestion).toBeUndefined()
    })
  })

  test("replies to pending permission requests from parent tools", async () => {
    await withTrackedSession(async ({ actions, manager, state }) => {
      await manager.handleEvent({
        event: {
          properties: {
            id: "permission-1",
            permission: "bash",
            sessionID: "child-session",
          },
          type: "permission.asked",
        },
      })

      const reply = await manager.replyPermission({ pr: 7557, reply: "reject" })

      expect(reply).toBe(
        "Replied to permission request permission-1 for security: reject.",
      )
      expect(actions).toMatchObject([
        {
          input: { reply: "reject", requestID: "permission-1" },
          type: "permission.reply",
        },
      ])
      expect(state.status).toBe("running")
      expect(state.reviewers.security.pendingPermission).toBeUndefined()
    })
  })

  test("notifies review phases and agent progress", async () => {
    await withTrackedSession(async ({ manager, prompts }) => {
      const privateManager = manager as unknown as {
        applyReviewProgress(runId: string, progress: unknown): Promise<void>
      }

      await privateManager.applyReviewProgress("run", {
        phase: "creating worktree",
        type: "phase",
      })
      await privateManager.applyReviewProgress("run", {
        type: "worktree_created",
        worktreePath: "/tmp/pr-7557",
      })
      await privateManager.applyReviewProgress("run", {
        reviewer: "security",
        type: "reviewer_started",
      })
      await privateManager.applyReviewProgress("run", {
        reviewer: "security",
        sessionId: "review-session",
        type: "reviewer_session",
      })
      await privateManager.applyReviewProgress("run", {
        reviewer: "security",
        sessionId: "review-session",
        type: "reviewer_response",
      })

      const texts = prompts.map(
        (prompt) =>
          (prompt as { body: { parts: { text: string }[] } }).body.parts[0]
            .text,
      )

      expect(texts).toEqual([
        "Creating worktree for [#7557](https://example.com/pull/7557).",
        "Worktree is ready for [#7557](https://example.com/pull/7557).",
        "**Reviewer security** started reviewing [#7557](https://example.com/pull/7557).",
      ])
    })
  })

  test("deletes the recorded worktree branch after completed review", async () => {
    const directory = await mkdtemp(join(tmpdir(), "magi-run-"))
    const { execCommands, manager } = managerWithPromptCapture(directory)
    const state = sampleReviewState(join(directory, "run"))
    const worktreePath = join(directory, "worktrees", "pr-7557")
    const privateManager = manager as unknown as {
      active: Map<string, MagiRunState>
      executeReview(input: Record<string, unknown>): Promise<void>
    }

    state.status = "running"
    privateManager.active.set("run", state)
    runReviewMock.mockImplementationOnce(
      async (input: { onProgress?: (progress: unknown) => Promise<void> }) => {
        await input.onProgress?.({
          branch: "pr-7557",
          type: "worktree_created",
          worktreePath,
        })

        return {
          outputs: {
            security: { findings: [], verdict: "MERGE" },
          },
          posted: { security: "approved" },
          report: "Report",
          sessionIds: {},
          verdict: "MERGE",
          worktreePath,
        }
      },
    )

    try {
      await privateManager.executeReview({
        config: { agents: { reviewers: [] } },
        pr: 7557,
        repository: sampleRepository(),
        runId: "run",
      })

      expect(execCommands).toContain(
        `git worktree remove --force '${worktreePath}'`,
      )
      expect(execCommands).toContain("git worktree prune")
      expect(execCommands).toContain("git branch -D 'pr-7557'")
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  test("notifies CI classifier progress and reports", async () => {
    await withTrackedSession(async ({ manager, prompts }) => {
      const privateManager = manager as unknown as {
        applyReviewProgress(runId: string, progress: unknown): Promise<void>
      }

      await privateManager.applyReviewProgress("run", {
        promptPath: "/tmp/classifier.prompt.txt",
        reviewer: "security",
        type: "ci_classifier_started",
      })
      await privateManager.applyReviewProgress("run", {
        reviewer: "security",
        sessionId: "ci-session",
        type: "ci_classifier_session",
      })
      await privateManager.applyReviewProgress("run", {
        classification: "SCOPE_OUT",
        rawPath: "/tmp/classifier.raw.txt",
        reason: "unrelated flaky check",
        reviewer: "security",
        sessionId: "ci-session",
        type: "ci_classifier_completed",
      })
      await privateManager.applyReviewProgress("run", {
        report: {
          attempts: 1,
          excluded: [],
          failed: [],
          rerun: [],
          scopeInside: [],
          scopeOutsideRecovered: [],
          scopeOutsideUnresolved: [],
        },
        type: "ci_report",
      })

      const texts = prompts.map(
        (prompt) =>
          (prompt as { body: { parts: { text: string }[] } }).body.parts[0]
            .text,
      )

      expect(texts).toEqual([
        "**CI classifier security** started for [#7557](https://example.com/pull/7557).",
        "**CI classifier security** completed for [#7557](https://example.com/pull/7557): SCOPE_OUT - unrelated flaky check",
        "CI report for [#7557](https://example.com/pull/7557): 0 failed, 0 scope-in, 0 rerun, 0 recovered, 0 unresolved.",
      ])
    })
  })

  test("formats completed status with report contents", async () => {
    const { manager } = managerWithPromptCapture()
    const directory = await mkdtemp(join(tmpdir(), "magi-run-"))
    const reportPath = join(directory, "report.md")
    const report = [
      "- **Check**: Pass",
      "- **Reviewer**:",
      "  - **codex**: Approved",
      "    - ~~`src/a.ts:1`: discarded finding~~",
      "",
    ].join("\n")

    try {
      await writeFile(reportPath, report)

      const text = await manager.formatStatesWithReports(
        [
          {
            command: "review",
            completedAt: "now",
            createdAt: "now",
            outputDir: directory,
            phase: "completed",
            pr: 7557,
            reportPath,
            repository: "repo",
            reviewers: {},
            runId: "run",
            status: "completed",
            updatedAt: "now",
          },
        ],
        { verbose: true },
      )

      expect(text).toContain("Report for #7557 (run):")
      expect(text).toContain(report.trimEnd())
      expect(text).toContain("~~`src/a.ts:1`: discarded finding~~")
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  test("keeps compact status free of internal identifiers", () => {
    const { manager } = managerWithPromptCapture()
    const text = manager.formatStates([
      {
        command: "review",
        createdAt: "now",
        outputDir: ".",
        phase: "completed",
        pr: 7557,
        repository: "repo",
        reviewers: {
          security: {
            account: "bot-a",
            repairAttempts: 0,
            sessionId: "child-session",
            status: "completed",
            toolCalls: 2,
            verdict: "MERGE",
          },
        },
        runId: "run",
        status: "completed",
        updatedAt: "now",
      },
    ])

    expect(text).not.toContain("Run: run")
    expect(text).not.toContain("session=child-session")
    expect(text).not.toContain("tools=2")
    expect(text).toContain("- security: completed (MERGE)")
  })

  test("clears inactive sessions, worktrees, branches, and outputs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "magi-clear-"))
    const { actions, execCommands, manager } =
      managerWithPromptCapture(directory)
    const outputDir = join(directory, "runs", "pr-7557", "run")
    const worktreePath = join(directory, "worktrees", "pr-7557")
    const state = sampleReviewState(outputDir)
    const privateManager = manager as unknown as {
      active: Map<string, MagiRunState>
    }

    state.status = "completed"
    state.phase = "completed"
    state.worktreeBranch = "pr-7557"
    state.worktreePath = worktreePath
    await mkdir(outputDir, { recursive: true })
    await mkdir(worktreePath, { recursive: true })
    await writeFile(join(outputDir, "state.json"), JSON.stringify(state))
    await writeFile(join(worktreePath, "file.txt"), "worktree")
    privateManager.active.set("run", state)

    try {
      const result = await manager.clear({ runId: "run" })

      expect(result).toContain("Cleared Magi runs: 1")
      expect(actions).toMatchObject([
        {
          input: { path: { id: "child-session" } },
          type: "session.delete",
        },
      ])
      expect(execCommands).toContain(
        `git worktree remove --force '${worktreePath}'`,
      )
      expect(execCommands).toContain("git worktree prune")
      expect(execCommands).toContain("git branch -D 'pr-7557'")
      await expect(stat(outputDir)).rejects.toMatchObject({ code: "ENOENT" })
      await expect(
        stat(join(directory, "runs", "pr-7557")),
      ).rejects.toMatchObject({ code: "ENOENT" })
      await expect(stat(join(directory, "runs"))).rejects.toMatchObject({
        code: "ENOENT",
      })
      await expect(stat(worktreePath)).rejects.toMatchObject({ code: "ENOENT" })
      await expect(stat(join(directory, "worktrees"))).rejects.toMatchObject({
        code: "ENOENT",
      })
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  test("prunes empty Magi directories when no runs are found", async () => {
    const directory = await mkdtemp(join(tmpdir(), "magi-clear-empty-"))
    const { manager } = managerWithPromptCapture(directory)

    await mkdir(join(directory, ".magi", "runs", "pr", "7563"), {
      recursive: true,
    })
    await mkdir(join(directory, ".magi", "worktrees"), { recursive: true })

    try {
      const result = await manager.clear({})

      expect(result).toContain("No Magi runs found: all runs")
      await expect(stat(join(directory, ".magi"))).rejects.toMatchObject({
        code: "ENOENT",
      })
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  test("skips active runs when clearing", async () => {
    const { actions, manager } = managerWithPromptCapture()
    const directory = await mkdtemp(join(tmpdir(), "magi-clear-active-"))
    const state = sampleReviewState(join(directory, "run"))
    const privateManager = manager as unknown as {
      active: Map<string, MagiRunState>
    }

    privateManager.active.set("run", state)

    try {
      const result = await manager.clear({ runId: "run" })

      expect(result).toContain("Cleared Magi runs: 0")
      expect(result).toContain("Skipped active runs: 1")
      expect(actions).toEqual([])
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })
})
