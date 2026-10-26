import type { PluginOptions } from "@opencode/plugin"
import type { Octokit } from "octokit"
import type { State } from "./magi"
import type { Config } from "@/config"
import type { Exec } from "@/utils"
import { print } from "graphql"
import { access, mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Readable } from "node:stream"
import { test } from "#/fixtures/magi"
import { DEFAULT_CONFIG } from "@/constant"
import { EnqueuePullRequestDocument } from "@/graphql/index.generated"

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  Octokit: vi.fn(),
  validateConfig: vi.fn(),
}))

vi.mock(import("@/config"), async (importOriginal) => ({
  ...(await importOriginal()),
  getConfig: mocks.getConfig,
  validateConfig: mocks.validateConfig,
}))

vi.mock("octokit", () => ({
  Octokit: class OctokitMock {
    public readonly mocked = true

    constructor(options: unknown) {
      mocks.Octokit(options)
    }
  },
}))

function createConfig(directory: string): Config.Root {
  const config = structuredClone(DEFAULT_CONFIG)

  config.review.output = join(directory, "review-runs")
  config.triage.output = join(directory, "triage-runs")

  return config
}

function createState(output: string, overrides: Partial<State> = {}): State {
  return {
    command: "review",
    createdAt: "2026-07-22T00:00:00.000Z",
    dryRun: false,
    id: "run-1",
    output,
    repo: "magi-ai/opencode-magi",
    sessionId: "parent-session",
    status: "completed",
    updatedAt: "2026-07-22T00:00:00.000Z",
    ...overrides,
  }
}

async function writeState(directory: string, state: State): Promise<void> {
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, "state.json"),
    `${JSON.stringify(state, null, 2)}\n`,
  )
}

function createEventStream(events: object[] = []): AsyncIterable<object> {
  return Readable.from(events)
}

describe("Magi", () => {
  beforeEach(() => {
    mocks.getConfig.mockReset()
    mocks.Octokit.mockReset()
    mocks.validateConfig.mockReset()
  })

  describe("constructor", () => {
    test("uses the v2 plugin context", ({ createMagi }) => {
      const options = {} as PluginOptions
      const { client, magi } = createMagi({
        dir: "/repository",
        options,
      })

      expect(magi.input.client).toBe(client)
      expect(magi.input.directory).toBe("/repository")
      expect(magi.options).toBe(options)
      expect(magi.exec).toBeTypeOf("function")
    })
  })

  describe("getGhToken", () => {
    test("requests the token for a selected account", async ({ magi }) => {
      const exec = vi.fn<Exec>().mockResolvedValue("token")
      const signal = new AbortController().signal

      magi.exec = exec

      await expect(magi.getGhToken("user", signal)).resolves.toBe("token")
      expect(exec).toHaveBeenCalledWith("gh auth token --user 'user'", {
        signal,
      })
    })

    test("requests the default account token", async ({ magi }) => {
      const exec = vi.fn<Exec>().mockResolvedValue("token")

      magi.exec = exec

      await expect(magi.getGhToken()).resolves.toBe("token")
      expect(exec).toHaveBeenCalledWith("gh auth token", { signal: undefined })
    })
  })

  describe("createOctokit", () => {
    test("configures authentication, retries, and throttling", async ({
      magi,
    }) => {
      const config = structuredClone(DEFAULT_CONFIG)
      const signal = new AbortController().signal

      config.github.retryApiAttempts = 2

      const getGhToken = vi.spyOn(magi, "getGhToken").mockResolvedValue("token")

      await expect(
        magi.createOctokit(config, signal, "octocat"),
      ).resolves.toBeTypeOf("object")
      expect(getGhToken).toHaveBeenCalledWith("octocat", signal)
      expect(mocks.Octokit).toHaveBeenCalledWith({
        auth: "token",
        request: { signal },
        retry: { retries: 2 },
        throttle: {
          onRateLimit: expect.any(Function),
          onSecondaryRateLimit: expect.any(Function),
        },
      })

      const options = mocks.Octokit.mock.calls[0]![0]

      expect(
        options.throttle.onRateLimit(0, { request: { retryCount: 1 } }),
      ).toBeTruthy()
      expect(
        options.throttle.onRateLimit(0, { request: { retryCount: 2 } }),
      ).toBeUndefined()
      expect(
        options.throttle.onSecondaryRateLimit(0, {
          request: { retryCount: 1 },
        }),
      ).toBeTruthy()
      expect(
        options.throttle.onSecondaryRateLimit(0, {
          request: { retryCount: 2 },
        }),
      ).toBeUndefined()
    })
  })

  describe("createGraphql", () => {
    test("prints documents and delegates requests to Octokit", async ({
      magi,
    }) => {
      const response = {
        enqueuePullRequest: { mergeQueueEntry: { id: "entry-1" } },
      }
      const request = vi.fn().mockResolvedValue(response)
      const graphql = magi.createGraphql({
        graphql: request,
      } as unknown as Octokit)

      await expect(graphql.enqueuePullRequest({ id: "pr-1" })).resolves.toBe(
        response,
      )
      expect(request).toHaveBeenCalledWith(print(EnqueuePullRequestDocument), {
        id: "pr-1",
      })
    })
  })

  describe("clear", () => {
    test("clears inactive runs and skips active runs", async ({
      createMagi,
      tmpDir,
    }) => {
      const config = createConfig(tmpDir)
      const { client, magi } = createMagi({ dir: tmpDir })
      const output = join(config.review.output, "run-completed")
      const activeOutput = join(config.triage.output, "run-active")
      const worktree = join(tmpDir, "worktrees", "run-completed")
      const state = createState(output, {
        creator: { sessionId: "creator-session" },
        editor: { sessionId: "editor-session" },
        operator: { sessionId: "operator-session" },
        reviewers: {
          first: { sessionId: "reviewer-session" },
          second: {},
        },
        voters: {
          first: { sessionId: "voter-session" },
        },
        worktree: {
          branch: "feature branch",
          path: worktree,
        },
      })
      const activeState = createState(activeOutput, {
        id: "run-active",
        sessionId: "active-session",
        status: "running",
      })
      const exec = vi.fn<Exec>().mockResolvedValue("")

      magi.exec = exec
      client.session.remove.mockResolvedValue(undefined)
      await writeState(output, state)
      await writeState(activeOutput, activeState)
      await mkdir(worktree, { recursive: true })
      await writeFile(join(worktree, "file.txt"), "content")
      await writeFile(join(config.review.output, "ignored.txt"), "content")

      await expect(magi.clear(config)).resolves.toStrictEqual({
        branch: 1,
        output: 1,
        run: 1,
        session: 6,
        skipped: 1,
        worktree: 1,
      })
      expect(
        client.session.remove.mock.calls.map(([value]) => value),
      ).toStrictEqual([
        { sessionID: "parent-session" },
        { sessionID: "editor-session" },
        { sessionID: "creator-session" },
        { sessionID: "operator-session" },
        { sessionID: "reviewer-session" },
        { sessionID: "voter-session" },
      ])
      expect(exec).toHaveBeenCalledWith(
        `git worktree remove --force '${worktree}'`,
      )
      expect(exec).toHaveBeenCalledWith("git branch -D 'feature branch'")
      await expect(access(output)).rejects.toMatchObject({ code: "ENOENT" })
      await expect(access(worktree)).rejects.toMatchObject({ code: "ENOENT" })
      await expect(access(activeOutput)).resolves.toBeUndefined()
    })

    test("continues when each cleanup operation fails", async ({
      createMagi,
      tmpDir,
    }) => {
      const config = createConfig(tmpDir)
      const scanDirectory = join(config.review.output, "run-failed")
      const { client, magi } = createMagi({ dir: tmpDir })
      const state = createState("\0", {
        worktree: {
          branch: "feature",
          path: "\0",
        },
      })

      vi.spyOn(magi, "exec").mockRejectedValue(new Error("exec failed"))
      client.session.remove.mockRejectedValue(new Error("delete failed"))
      await writeState(scanDirectory, state)

      await expect(magi.clear(config)).resolves.toStrictEqual({
        branch: 0,
        output: 0,
        run: 1,
        session: 0,
        skipped: 0,
        worktree: 0,
      })
    })

    test("counts completed runs when cleanup is disabled", async ({
      createMagi,
      tmpDir,
    }) => {
      const config = createConfig(tmpDir)
      const output = join(config.review.output, "run-completed")
      const { client, magi } = createMagi({ dir: tmpDir })
      const exec = vi.fn<Exec>()

      config.clear = {
        branch: false,
        output: false,
        session: false,
        worktree: false,
      }
      magi.exec = exec
      await writeState(output, createState(output))

      await expect(magi.clear(config)).resolves.toStrictEqual({
        branch: 0,
        output: 0,
        run: 1,
        session: 0,
        skipped: 0,
        worktree: 0,
      })
      expect(client.session.remove).not.toHaveBeenCalled()
      expect(exec).not.toHaveBeenCalled()
      await expect(access(output)).resolves.toBeUndefined()
    })
  })

  describe("getPath", () => {
    test("resolves relative paths and preserves absolute paths", ({
      createMagi,
    }) => {
      const { magi } = createMagi({ dir: "/repository" })

      expect(magi.getPath("output/run-1")).toBe("/repository/output/run-1")
      expect(magi.getPath("/tmp/run-1")).toBe("/tmp/run-1")
    })
  })

  describe("getConfig", () => {
    test("returns a valid config", async ({ magi }) => {
      const config = structuredClone(DEFAULT_CONFIG)
      const require = { reviewers: true }

      mocks.getConfig.mockResolvedValue(config)
      mocks.validateConfig.mockResolvedValue([])

      await expect(magi.getConfig(require)).resolves.toBe(config)
      expect(mocks.getConfig).toHaveBeenCalledWith(magi.input)
      expect(mocks.validateConfig).toHaveBeenCalledWith(config, {
        exec: magi.exec,
        require,
      })
    })

    test("joins validation errors", async ({ magi }) => {
      const config = structuredClone(DEFAULT_CONFIG)

      mocks.getConfig.mockResolvedValue(config)
      mocks.validateConfig.mockResolvedValue(["First error", "Second error"])

      await expect(magi.getConfig()).rejects.toThrow(
        "First error\nSecond error",
      )
    })
  })

  describe("createState", () => {
    test("creates and persists an initial state", async ({
      createMagi,
      tmpDir,
    }) => {
      const { magi } = createMagi({ dir: tmpDir })
      const state = await magi.createState("runs", {
        command: "triage",
        dryRun: false,
        issue: {
          number: 42,
          url: "https://github.com/magi-ai/opencode-magi/issues/42",
        },
        repo: "magi-ai/opencode-magi",
        sessionId: "parent-session",
      })

      expect(state).toMatchObject({
        command: "triage",
        dryRun: false,
        status: "preparing",
      })
      expect(state.id).toMatch(/^run-[a-z0-9]+-[a-f0-9]{8}$/)
      expect(state.output.startsWith(join(tmpDir, "runs"))).toBeTruthy()
      expect(state.createdAt).toBe(state.updatedAt)
      await expect(
        readFile(join(state.output, "state.json"), "utf8"),
      ).resolves.toBe(`${JSON.stringify(state, null, 2)}\n`)
    })
  })

  describe("createAgentFile", () => {
    test("includes the cycle and attempt in the filename", async ({
      magi,
      tmpDir,
    }) => {
      await magi.createAgentFile(tmpDir, "review", "reviewer-1", "result", 2, 3)

      await expect(
        readFile(join(tmpDir, "reviewer-1-review-3-2.md"), "utf8"),
      ).resolves.toBe("result")
    })

    test("uses the default attempt when the cycle is omitted", async ({
      magi,
      tmpDir,
    }) => {
      await magi.createAgentFile(tmpDir, "review", "reviewer-1", "result")

      await expect(
        readFile(join(tmpDir, "reviewer-1-review-1.md"), "utf8"),
      ).resolves.toBe("result")
    })

    test("omits an invalid runtime attempt", async ({ magi, tmpDir }) => {
      await magi.createAgentFile(
        tmpDir,
        "review",
        "reviewer-1",
        "result",
        null as unknown as number,
      )

      await expect(
        readFile(join(tmpDir, "reviewer-1-review.md"), "utf8"),
      ).resolves.toBe("result")
    })
  })

  describe("updateState", () => {
    test("deeply merges and persists a state update", async ({
      createMagi,
      tmpDir,
    }) => {
      const { magi } = createMagi({ dir: tmpDir })
      const state = await magi.createState("runs", {
        command: "triage",
        dryRun: false,
        issue: {
          number: 42,
          url: "https://github.com/magi-ai/opencode-magi/issues/42",
        },
        repo: "magi-ai/opencode-magi",
        sessionId: "parent-session",
      })
      const next = {
        issue: {
          url: "https://github.com/magi-ai/opencode-magi/issues/43",
        },
        status: "running" as const,
      }
      const updated = await magi.updateState(state.output, next)

      expect(updated.issue).toStrictEqual({
        number: 42,
        url: "https://github.com/magi-ai/opencode-magi/issues/43",
      })
      expect(updated.status).toBe("running")
      expect(next).toHaveProperty("updatedAt", updated.updatedAt)
      await expect(
        readFile(join(state.output, "state.json"), "utf8"),
      ).resolves.toBe(`${JSON.stringify(updated, null, 2)}\n`)
    })
  })

  describe("updateEvent", () => {
    test("appends a JSON event", async ({ magi, tmpDir }) => {
      await magi.updateEvent(tmpDir, "Preparing run")

      const content = await readFile(join(tmpDir, "events.jsonl"), "utf8")
      const event = JSON.parse(content) as {
        createdAt: string
        message: string
      }

      expect(event.message).toBe("Preparing run")
      expect(Number.isNaN(Date.parse(event.createdAt))).toBeFalsy()
      expect(content.endsWith("\n")).toBeTruthy()
    })
  })

  describe("getEvents", () => {
    test("returns an empty array when the event file is missing", async ({
      magi,
      tmpDir,
    }) => {
      await expect(magi.getEvents(tmpDir)).resolves.toStrictEqual([])
    })

    test("parses non-empty event lines", async ({ magi, tmpDir }) => {
      await writeFile(
        join(tmpDir, "events.jsonl"),
        '{"createdAt":"first","message":"First"}\n\n' +
          '{"createdAt":"second","message":"Second"}\n',
      )

      await expect(magi.getEvents(tmpDir)).resolves.toStrictEqual([
        { createdAt: "first", message: "First" },
        { createdAt: "second", message: "Second" },
      ])
    })

    test("rethrows errors other than a missing file", async ({
      magi,
      tmpDir,
    }) => {
      await mkdir(join(tmpDir, "events.jsonl"))

      await expect(magi.getEvents(tmpDir)).rejects.toMatchObject({
        code: "EISDIR",
      })
    })
  })

  describe("createSession", () => {
    test("creates a child session with model and permissions", async ({
      client,
      magi,
    }) => {
      const signal = new AbortController().signal

      client.session.create.mockResolvedValue({ id: "child-session" })

      await expect(
        magi.createSession(
          "parent-session",
          "Reviewer",
          {
            model: {
              id: "provider/model",
              variant: "high",
            },
            permissions: {
              read: "allow",
            },
          },
          signal,
        ),
      ).resolves.toBe("child-session")
      expect(client.session.create).toHaveBeenCalledWith(
        {
          model: {
            id: "model",
            providerID: "provider",
            variant: "high",
          },
          parentID: "parent-session",
          permissions: [
            {
              action: "read",
              effect: "allow",
              resource: "*",
            },
          ],
          title: "Reviewer",
        },
        { signal },
      )
    })

    test("rejects unresolved model values", async ({ client, magi }) => {
      await expect(
        magi.createSession("parent-session", "Reviewer", { model: undefined }),
      ).rejects.toBeInstanceOf(Error)
      await expect(
        magi.createSession("parent-session", "Reviewer", {
          model: "provider/model",
        }),
      ).rejects.toBeInstanceOf(Error)
      await expect(
        magi.createSession("parent-session", "Reviewer", {
          model: ["provider/model"],
        }),
      ).rejects.toBeInstanceOf(Error)
      expect(client.session.create).not.toHaveBeenCalled()
    })

    test("propagates a server error", async ({ client, magi }) => {
      client.session.create.mockRejectedValue(new Error("Bad Gateway"))

      await expect(
        magi.createSession("parent-session", "Reviewer", {
          model: { id: "provider/model" },
        }),
      ).rejects.toThrow("Bad Gateway")
    })

    test("uses an Error message for an API error", async ({ client, magi }) => {
      client.session.create.mockRejectedValue(new Error("connection refused"))

      await expect(
        magi.createSession("parent-session", "Reviewer", {
          model: { id: "provider/model" },
        }),
      ).rejects.toThrow("connection refused")
    })
  })

  describe("promptSession", () => {
    test("returns text parts and closes the event subscription", async ({
      client,
      magi,
    }) => {
      const signal = new AbortController().signal

      client.session.context.mockResolvedValue([
        {
          content: [{ text: "Stale", type: "text" }],
          id: "old-response",
          time: { created: 0 },
          type: "assistant",
        },
        { id: "prompt-id", type: "user" },
        {
          content: [
            { text: "First", type: "text" },
            { type: "tool" },
            { text: "Second", type: "text" },
          ],
          id: "response",
          time: { created: 2 },
          type: "assistant",
        },
      ])

      await expect(
        magi.promptSession("session", "Review this PR", signal),
      ).resolves.toBe("First\nSecond")
      expect(client.event.subscribe).toHaveBeenCalledWith({
        signal: expect.any(AbortSignal),
      })
      expect(client.session.prompt).toHaveBeenCalledWith(
        {
          sessionID: "session",
          text: "Review this PR",
        },
        { signal: expect.any(AbortSignal) },
      )
      expect(client.session.wait).toHaveBeenCalledWith(
        { sessionID: "session" },
        { signal: expect.any(AbortSignal) },
      )
      expect(client.session.context).toHaveBeenCalledWith(
        { sessionID: "session" },
        { signal: expect.any(AbortSignal) },
      )

      const subscriptionSignal = client.event.subscribe.mock.calls[0]![0].signal

      expect(subscriptionSignal.aborted).toBeTruthy()
    })

    test("rejects an empty text response", async ({ client, magi }) => {
      client.session.context.mockResolvedValue([
        { id: "prompt-id", type: "user" },
        {
          content: [{ type: "tool" }],
          id: "response",
          time: { created: 2 },
          type: "assistant",
        },
      ])

      await expect(magi.promptSession("session", "text")).rejects.toThrow(
        "OpenCode session.prompt did not return text output.",
      )
      expect(client.session.interrupt).not.toHaveBeenCalled()
    })

    test("propagates prompt admission errors", async ({ client, magi }) => {
      client.session.prompt.mockRejectedValue(new Error("Bad Gateway"))

      await expect(magi.promptSession("session", "text")).rejects.toThrow(
        "Bad Gateway",
      )
    })

    test("propagates session wait errors", async ({ client, magi }) => {
      client.session.wait.mockRejectedValue(new Error("connection refused"))

      await expect(magi.promptSession("session", "text")).rejects.toThrow(
        "connection refused",
      )
    })

    test("propagates model errors instead of returning partial output", async ({
      client,
      magi,
    }) => {
      client.session.context.mockResolvedValue([
        { id: "prompt-id", type: "user" },
        {
          content: [{ text: "Partial", type: "text" }],
          error: { message: "Model failed" },
          id: "response",
          time: { created: 2 },
          type: "assistant",
        },
      ])

      await expect(magi.promptSession("session", "text")).rejects.toThrow(
        "Model failed",
      )
    })

    test("rejects permission requests and aborts the session", async ({
      client,
      magi,
    }) => {
      client.event.subscribe.mockReturnValue(
        createEventStream([
          {
            data: {
              action: "shell",
              id: "ignored-permission",
              resources: ["git status"],
              sessionID: "other-session",
            },
            type: "permission.asked",
          },
          {
            data: {
              form: { id: "ignored-question", sessionID: "other-session" },
            },
            type: "form.created",
          },
          { data: {}, type: "session.updated" },
          {
            data: {
              action: "shell",
              id: "permission-request",
              resources: ["git push", "git tag"],
              sessionID: "session",
            },
            type: "permission.asked",
          },
        ]),
      )
      client.permission.reply.mockResolvedValue(undefined)
      client.session.prompt.mockReturnValue(new Promise(() => {}))

      await expect(magi.promptSession("session", "text")).rejects.toMatchObject(
        {
          message:
            "OpenCode session requested shell permission for git push, git tag.",
          name: "MagiError",
          status: "blocked",
        },
      )
      expect(client.permission.reply).toHaveBeenCalledWith({
        decision: "reject",
        requestID: "permission-request",
        sessionID: "session",
      })
      expect(client.session.interrupt).toHaveBeenCalledWith({
        resume: false,
        sessionID: "session",
      })
    })

    test("reports a permission rejection failure", async ({ client, magi }) => {
      client.event.subscribe.mockReturnValue(
        createEventStream([
          {
            data: {
              action: "shell",
              id: "permission-request",
              resources: ["git push"],
              sessionID: "session",
            },
            type: "permission.asked",
          },
        ]),
      )
      client.permission.reply.mockRejectedValue(new Error("failed"))
      client.session.prompt.mockReturnValue(new Promise(() => {}))

      await expect(magi.promptSession("session", "text")).rejects.toMatchObject(
        {
          message: "Could not reject permission request.",
          status: "blocked",
        },
      )
      expect(client.session.interrupt).toHaveBeenCalledWith({
        resume: false,
        sessionID: "session",
      })
    })

    test("interrupts sessions requesting user input", async ({
      client,
      magi,
    }) => {
      client.event.subscribe.mockReturnValue(
        createEventStream([
          {
            data: { form: { id: "question-request", sessionID: "session" } },
            type: "form.created",
          },
        ]),
      )
      client.session.prompt.mockReturnValue(new Promise(() => {}))

      await expect(magi.promptSession("session", "text")).rejects.toMatchObject(
        {
          message: "OpenCode session requested user input.",
          status: "blocked",
        },
      )
      expect(client.session.interrupt).toHaveBeenCalledWith({
        resume: false,
        sessionID: "session",
      })
    })

    test("interrupts the child session even when the v2 adapter ignores the signal", async ({
      client,
      magi,
    }) => {
      const controller = new AbortController()

      client.session.wait.mockImplementation(() => {
        controller.abort(new DOMException("Aborted", "AbortError"))

        return new Promise(() => {})
      })

      await expect(
        magi.promptSession("session", "text", controller.signal),
      ).rejects.toThrow("Aborted")
      expect(client.session.interrupt).toHaveBeenCalledWith({
        resume: false,
        sessionID: "session",
      })
      expect(client.session.context).not.toHaveBeenCalled()
    })

    test("does not return stale output when the prompt is missing from context", async ({
      client,
      magi,
    }) => {
      client.session.context.mockResolvedValue([
        {
          content: [{ text: "Stale", type: "text" }],
          id: "old-response",
          time: { created: 0 },
          type: "assistant",
        },
      ])

      await expect(magi.promptSession("session", "text")).rejects.toThrow(
        "did not return text output",
      )
    })

    test("rejects a turn with no assistant response", async ({
      client,
      magi,
    }) => {
      client.session.context.mockResolvedValue([
        { id: "prompt-id", type: "user" },
      ])

      await expect(magi.promptSession("session", "text")).rejects.toThrow(
        "did not return text output",
      )
    })

    test("returns the response after compaction removes the user prompt", async ({
      client,
      magi,
    }) => {
      client.session.context.mockResolvedValue([
        { id: "compaction", type: "compaction.completed" },
        {
          content: [{ text: "Review completed", type: "text" }],
          id: "response",
          time: { created: 2 },
          type: "assistant",
        },
      ])

      await expect(magi.promptSession("session", "text")).resolves.toBe(
        "Review completed",
      )
    })

    test("does not submit a prompt when already cancelled", async ({
      client,
      magi,
    }) => {
      const signal = AbortSignal.abort(new Error("Cancelled"))

      await expect(
        magi.promptSession("session", "text", signal),
      ).rejects.toThrow("Cancelled")
      expect(client.session.prompt).not.toHaveBeenCalled()
      expect(client.event.subscribe).not.toHaveBeenCalled()
    })
  })

  describe("createWorktree", () => {
    test("creates a pull request worktree and returns its branch", async ({
      createMagi,
      tmpDir,
    }) => {
      const { magi } = createMagi({ dir: tmpDir })
      const exec = vi
        .fn<Exec>()
        .mockResolvedValueOnce("")
        .mockResolvedValueOnce("")
        .mockResolvedValueOnce("feature")
      const signal = new AbortController().signal
      const path = join(tmpDir, "worktrees", "42", "run-1")

      magi.exec = exec

      await expect(
        magi.createWorktree("worktrees", 42, "run-1", signal),
      ).resolves.toStrictEqual({ branch: "feature", path })
      expect(exec.mock.calls).toStrictEqual([
        [`git worktree add --detach '${path}'`, { signal }],
        ["gh pr checkout 42 --detach", { cwd: path, signal }],
        ["git branch --show-current", { cwd: path, signal }],
      ])
    })

    test("omits an empty branch name", async ({ createMagi, tmpDir }) => {
      const { magi } = createMagi({ dir: tmpDir })
      const exec = vi.fn<Exec>().mockResolvedValue("")
      const path = join(tmpDir, "worktrees", "42", "run-1")

      magi.exec = exec

      await expect(
        magi.createWorktree("worktrees", 42, "run-1"),
      ).resolves.toStrictEqual({ branch: undefined, path })
    })

    test("cleans up and rethrows when checkout fails", async ({
      createMagi,
      tmpDir,
    }) => {
      const { magi } = createMagi({ dir: tmpDir })
      const error = new Error("checkout failed")
      const exec = vi
        .fn<Exec>()
        .mockResolvedValueOnce("")
        .mockRejectedValueOnce(error)
        .mockResolvedValue("")
      const path = join(tmpDir, "worktrees", "42", "run-1")

      magi.exec = exec

      await expect(magi.createWorktree("worktrees", 42, "run-1")).rejects.toBe(
        error,
      )
      expect(exec.mock.calls).toStrictEqual([
        [`git worktree add --detach '${path}'`, { signal: undefined }],
        ["gh pr checkout 42 --detach", { cwd: path, signal: undefined }],
        [`git worktree remove --force '${path}'`],
        ["git worktree prune"],
      ])
    })

    test("preserves the original error when cleanup fails", async ({
      createMagi,
      tmpDir,
    }) => {
      const { magi } = createMagi({ dir: tmpDir })
      const error = new Error("worktree failed")
      const exec = vi
        .fn<Exec>()
        .mockRejectedValueOnce(error)
        .mockRejectedValueOnce(new Error("cleanup failed"))

      magi.exec = exec

      await expect(magi.createWorktree("worktrees", 42, "run-1")).rejects.toBe(
        error,
      )
      expect(exec).toHaveBeenCalledTimes(2)
    })
  })

  describe("deleteWorktree", () => {
    test("removes the git worktree and its directory", async ({
      createMagi,
      tmpDir,
    }) => {
      const { magi } = createMagi({ dir: tmpDir })
      const exec = vi.fn<Exec>().mockResolvedValue("")
      const path = join(tmpDir, "worktrees", "run-1")

      magi.exec = exec
      await mkdir(path, { recursive: true })
      await writeFile(join(path, "file.txt"), "content")

      await expect(magi.deleteWorktree("worktrees/run-1")).resolves.toBe(1)
      expect(exec).toHaveBeenCalledWith(`git worktree remove --force '${path}'`)
      await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" })
    })

    test("returns zero when the git command fails", async ({
      createMagi,
      tmpDir,
    }) => {
      const { magi } = createMagi({ dir: tmpDir })
      const path = join(tmpDir, "worktrees", "run-1")

      vi.spyOn(magi, "exec").mockRejectedValue(new Error("remove failed"))
      await mkdir(path, { recursive: true })

      await expect(magi.deleteWorktree("worktrees/run-1")).resolves.toBe(0)
      await expect(access(path)).resolves.toBeUndefined()
    })

    test("returns zero when filesystem removal fails", async ({ magi }) => {
      vi.spyOn(magi, "exec").mockResolvedValue("")

      await expect(magi.deleteWorktree("\0")).resolves.toBe(0)
    })
  })
})
