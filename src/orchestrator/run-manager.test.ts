import type { ModelClient } from "./model"
import type { MagiRunState } from "./run-manager"
import type { ResolvedRepository } from "../types"
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test, vi } from "vitest"

const runReviewMock = vi.hoisted(() => vi.fn())
const runTriageMock = vi.hoisted(() => vi.fn())

vi.mock("./review", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./review")>()

  return { ...actual, runReview: runReviewMock }
})

vi.mock("./triage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./triage")>()

  return { ...actual, runTriage: runTriageMock }
})

import { MagiRunManager, redactSecrets } from "./run-manager"

describe("MagiRunManager notifications", () => {
  afterEach(() => {
    runReviewMock.mockReset()
    runTriageMock.mockReset()
    vi.restoreAllMocks()
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

  function sampleTriageRepository(
    automation: NonNullable<ResolvedRepository["triage"]>["automation"],
  ): ResolvedRepository {
    return {
      ...sampleRepository(),
      agents: {
        ...sampleRepository().agents,
        triage: [],
      },
      triage: {
        automation,
        categories: [],
        concurrency: { runs: 1 },
        prompts: {},
        safety: {
          allowAuthors: [],
          allowMentionActors: [],
          allowMentionRoles: [],
          blockedLabels: [],
          requiredLabels: [],
        },
      },
    }
  }

  function sampleTriageState(outputDir: string): MagiRunState {
    return {
      command: "triage",
      createdAt: "now",
      issue: 115,
      issueUrl: "https://example.com/issues/115",
      outputDir,
      parentSessionId: "parent-session",
      phase: "triaging",
      repository: "repo",
      reviewers: {},
      runId: "triage-run",
      status: "running",
      updatedAt: "now",
    }
  }

  async function executeTriageWithAutomation(
    automation: NonNullable<ResolvedRepository["triage"]>["automation"],
  ) {
    const directory = await mkdtemp(join(tmpdir(), "magi-triage-follow-up-"))
    const { manager } = managerWithPromptCapture(directory)
    const repository = sampleTriageRepository(automation)
    const state = sampleTriageState(join(directory, "triage"))
    const reviewState = sampleReviewState(join(directory, "review"))
    const mergeState: MagiRunState = {
      ...reviewState,
      command: "merge",
      outputDir: join(directory, "merge"),
    }
    const privateManager = manager as unknown as {
      active: Map<string, MagiRunState>
      executeTriage(input: Record<string, unknown>): Promise<void>
    }
    const startReview = vi
      .spyOn(manager, "startReview")
      .mockResolvedValue(reviewState)
    const startMerge = vi
      .spyOn(manager, "startMerge")
      .mockResolvedValue(mergeState)

    privateManager.active.set("triage-run", state)
    runTriageMock.mockResolvedValueOnce({
      issue: 115,
      outputDir: state.outputDir,
      prUrl: "https://github.com/owner/repo/pull/30",
      report: "Triage report",
      result: { category: "feature", disposition: "accepted" },
    })

    try {
      await privateManager.executeTriage({
        config: { github: { owner: "owner", repo: "repo" } },
        dryRun: false,
        issue: 115,
        parentSessionId: "parent-session",
        repository,
        runId: "triage-run",
      })

      return { startMerge, startReview }
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  }

  test("starts review automation after triage creates a PR", async () => {
    const { startMerge, startReview } = await executeTriageWithAutomation({
      clear: ["triage"],
      close: false,
      create: true,
      merge: false,
      review: true,
    })

    expect(startReview).toHaveBeenCalledWith(
      expect.objectContaining({
        dryRun: false,
        parentSessionId: "parent-session",
        pr: 30,
      }),
    )
    expect(startMerge).not.toHaveBeenCalled()
  })

  test("starts only merge automation when both triage follow-ups are enabled", async () => {
    const { startMerge, startReview } = await executeTriageWithAutomation({
      clear: ["triage"],
      close: false,
      create: true,
      merge: true,
      review: true,
    })

    expect(startMerge).toHaveBeenCalledWith(
      expect.objectContaining({
        dryRun: false,
        parentSessionId: "parent-session",
        pr: 30,
      }),
    )
    expect(startReview).not.toHaveBeenCalled()
  })

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

  test("redacts tokens from error text", () => {
    expect(
      redactSecrets("Command failed: GH_TOKEN='secret-token' gh pr merge 1"),
    ).toBe("Command failed: GH_TOKEN=<redacted> gh pr merge 1")
    expect(redactSecrets("echo password=secret-token; git push")).toBe(
      "echo password=<redacted>; git push",
    )
  })

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
    const directory = await mkdtemp(join(tmpdir(), "magi-run-"))
    const state: MagiRunState = {
      command: "review",
      createdAt: "now",
      outputDir: directory,
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
    try {
      await privateManager.applyReviewProgress("run", {
        error: "Invalid JSON",
        reviewer: "security",
        type: "reviewer_failed",
      })
    } finally {
      await rm(directory, { force: true, recursive: true })
    }

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
    const directory = await mkdtemp(join(tmpdir(), "magi-run-"))
    const state: MagiRunState = {
      command: "merge",
      createdAt: "now",
      editor: {
        account: "bot-editor",
        repairAttempts: 1,
        status: "repairing",
        toolCalls: 0,
      },
      outputDir: directory,
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
    try {
      await privateManager.applyMergeProgress("run", {
        cycle: 1,
        error: "Invalid JSON",
        type: "editor_failed",
      })
    } finally {
      await rm(directory, { force: true, recursive: true })
    }

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

  test("tracks triage creator progress and notifications", async () => {
    const { manager, prompts } = managerWithPromptCapture()
    const directory = await mkdtemp(join(tmpdir(), "magi-run-"))
    const state: MagiRunState = {
      command: "triage",
      createdAt: "now",
      issue: 105,
      issueUrl: "https://example.com/issues/105",
      outputDir: directory,
      parentSessionId: "parent-session",
      phase: "triaging",
      repository: "repo",
      reviewers: {
        Melchior: {
          account: "",
          repairAttempts: 0,
          status: "pending",
          toolCalls: 0,
        },
      },
      runId: "run",
      status: "running",
      triageCreator: {
        account: "creator-bot",
        repairAttempts: 0,
        status: "pending",
        toolCalls: 0,
      },
      updatedAt: "now",
    }
    const privateManager = manager as unknown as {
      active: Map<string, MagiRunState>
      applyTriageProgress(runId: string, progress: unknown): Promise<void>
      sessionToRun: Map<string, { agent: string; runId: string }>
    }

    privateManager.active.set("run", state)
    try {
      await privateManager.applyTriageProgress("run", {
        type: "pr_creation_started",
      })
      await privateManager.applyTriageProgress("run", {
        type: "triage_creator_started",
      })
      await privateManager.applyTriageProgress("run", {
        sessionId: "creator-session",
        type: "triage_creator_session",
      })
      await privateManager.applyTriageProgress("run", {
        sessionId: "creator-session",
        type: "triage_creator_completed",
      })
      await privateManager.applyTriageProgress("run", {
        type: "pr_created",
        url: "https://example.com/pull/106",
      })
    } finally {
      await rm(directory, { force: true, recursive: true })
    }

    expect(state.phase).toBe("creating implementation PR")
    expect(state.triageCreator).toMatchObject({
      sessionId: "creator-session",
      status: "completed",
    })
    expect(privateManager.sessionToRun.get("creator-session")).toEqual({
      agent: "triageCreator",
      runId: "run",
    })
    expect(
      prompts.map(
        (prompt) =>
          (prompt as { body: { parts: { text: string }[] } }).body.parts[0]
            .text,
      ),
    ).toEqual([
      "Started implementation PR creation for [#105](https://example.com/issues/105).",
      "**Triage creator** started creating an implementation PR for [#105](https://example.com/issues/105).",
      "**Triage creator** completed implementation changes for [#105](https://example.com/issues/105).",
      "Created implementation PR for [#105](https://example.com/issues/105): https://example.com/pull/106",
    ])
  })

  test("notifies triage creator failures", async () => {
    const { manager, prompts } = managerWithPromptCapture()
    const directory = await mkdtemp(join(tmpdir(), "magi-run-"))
    const state: MagiRunState = {
      command: "triage",
      createdAt: "now",
      issue: 105,
      issueUrl: "https://example.com/issues/105",
      outputDir: directory,
      parentSessionId: "parent-session",
      phase: "creating implementation PR",
      repository: "repo",
      reviewers: {},
      runId: "run",
      status: "running",
      triageCreator: {
        account: "creator-bot",
        repairAttempts: 1,
        status: "repairing",
        toolCalls: 0,
      },
      updatedAt: "now",
    }
    const privateManager = manager as unknown as {
      active: Map<string, MagiRunState>
      applyTriageProgress(runId: string, progress: unknown): Promise<void>
    }

    privateManager.active.set("run", state)
    try {
      await privateManager.applyTriageProgress("run", {
        error: "Invalid JSON",
        type: "triage_creator_failed",
      })
    } finally {
      await rm(directory, { force: true, recursive: true })
    }

    expect(state.triageCreator?.status).toBe("failed")
    expect(prompts).toMatchObject([
      {
        body: {
          parts: [
            {
              synthetic: true,
              text: "**Triage creator** failed creating an implementation PR for [#105](https://example.com/issues/105) after 1 JSON regeneration attempt: Invalid JSON",
              type: "text",
            },
          ],
        },
        path: { id: "parent-session" },
      },
    ])
  })

  test("marks active triage creator cancelled when cancelling run", async () => {
    const { manager } = managerWithPromptCapture()
    const directory = await mkdtemp(join(tmpdir(), "magi-run-"))
    const state: MagiRunState = {
      command: "triage",
      createdAt: "now",
      error: "User cancelled run",
      issue: 105,
      issueUrl: "https://example.com/issues/105",
      outputDir: directory,
      parentSessionId: "parent-session",
      phase: "creating implementation PR",
      repository: "repo",
      reviewers: {},
      runId: "run",
      status: "running",
      triageCreator: {
        account: "creator-bot",
        repairAttempts: 0,
        sessionId: "creator-session",
        status: "running",
        toolCalls: 0,
      },
      updatedAt: "now",
    }
    const privateManager = manager as unknown as {
      active: Map<string, MagiRunState>
    }

    privateManager.active.set("run", state)
    try {
      const cancelled = await manager.cancel({ runId: "run" })

      expect(cancelled?.triageCreator).toMatchObject({
        status: "cancelled",
      })
      expect(cancelled?.triageCreator?.error).toBeUndefined()
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
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
            security: {
              findings: [],
              requirementFindings: [],
              verdict: "MERGE",
            },
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

  test("passes the resolved approval policy to review runs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "magi-run-"))
    const { manager } = managerWithPromptCapture(directory)
    const state = sampleReviewState(join(directory, "run"))
    const repository = sampleRepository()
    const privateManager = manager as unknown as {
      active: Map<string, MagiRunState>
      executeReview(input: Record<string, unknown>): Promise<void>
    }

    repository.merge.approvalPolicy = "unanimous"
    state.status = "running"
    privateManager.active.set("run", state)
    runReviewMock.mockResolvedValueOnce({
      outputs: {
        security: { findings: [], requirementFindings: [], verdict: "MERGE" },
      },
      posted: { security: "approved" },
      report: "Report",
      sessionIds: {},
      verdict: "MERGE",
    })

    try {
      await privateManager.executeReview({
        config: { agents: { reviewers: [] } },
        pr: 7557,
        repository,
        runId: "run",
      })

      expect(runReviewMock).toHaveBeenCalledWith(
        expect.objectContaining({ approvalPolicy: "unanimous" }),
      )
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

  test("formats triage creator status", () => {
    const { manager } = managerWithPromptCapture()
    const text = manager.formatStates(
      [
        {
          command: "triage",
          createdAt: "now",
          issue: 105,
          outputDir: ".",
          phase: "creating implementation PR",
          repository: "repo",
          reviewers: {},
          runId: "run",
          status: "running",
          triageCreator: {
            account: "creator-bot",
            repairAttempts: 0,
            sessionId: "creator-session",
            status: "running",
            toolCalls: 1,
          },
          updatedAt: "now",
        },
      ],
      { verbose: true },
    )

    expect(text).toContain("Issue: #105")
    expect(text).toContain(
      "- triageCreator: running (session=creator-session, tools=1)",
    )
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
    await mkdir(join(directory, ".magi", "worktrees", "pr"), {
      recursive: true,
    })

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
