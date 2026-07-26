import type { ToolContext } from "@opencode-ai/plugin"
import type { Octokit } from "octokit"
import type { EditOutput } from "."
import type { ReviewFixture } from "#/fixtures/review"
import type { Graphql } from "@/graphql"
import type { Magi } from "@/magi"
import type { PullRequestReviewThread } from "@/tools/review"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { test } from "#/fixtures/magi"
import {
  createConfig,
  createMetadata,
  createReviewFixture,
  createState,
} from "#/fixtures/review"
import { MagiError } from "@/magi"
import { Prompt } from "@/prompts"
import { marker } from "@/utils"
import { Merge } from "./merge"

interface MergeFixture extends ReviewFixture<Merge> {
  merge: Merge
}

function createMergeFixture(magi: Magi): MergeFixture {
  const fixture = createReviewFixture(magi, Merge, { command: "merge" })

  return { ...fixture, merge: fixture.review }
}

function createEditOutput(overrides: Partial<EditOutput> = {}): EditOutput {
  return {
    filesTouched: [],
    mode: "REPLIED",
    responses: [],
    ...overrides,
  }
}

describe("Merge", () => {
  describe("init", () => {
    test("creates a merge state and records the start event", async ({
      magiFixture: { magi },
    }) => {
      const config = createConfig()
      const context = {
        abort: new AbortController().signal,
        sessionID: "parent-session",
      } as ToolContext
      const octokit = {} as Octokit
      const graphql = {} as Graphql
      const state = createState({ command: "merge" })

      config.review.output = "/merge-output"
      config.review.operator = "one"
      vi.spyOn(magi, "createOctokit").mockResolvedValue(octokit)
      vi.spyOn(magi, "createGraphql").mockReturnValue(graphql)

      const createStateSpy = vi
        .spyOn(magi, "createState")
        .mockResolvedValue(state)
      const updateEvent = vi.spyOn(magi, "updateEvent").mockResolvedValue()
      const merge = await Merge.init(42, magi, config, context, {
        dryRun: true,
      })

      expect(createStateSpy).toHaveBeenCalledWith("/merge-output/42", {
        command: "merge",
        dryRun: true,
        editor: {
          account: "editor",
          author: { email: "editor@example.com", name: "Editor" },
          model: "editor-model",
          permissions: "allow",
        },
        operator: config.review.reviewers![0],
        pr: {
          number: 42,
          url: "https://github.com/magi-ai/opencode-magi/pull/42",
        },
        repo: "'magi-ai/opencode-magi'",
        reviewers: {
          one: {
            account: "reviewer-one",
            model: "model-one",
            permissions: undefined,
          },
          three: {
            account: "reviewer-three",
            model: "model-three",
            permissions: undefined,
          },
          two: {
            account: "reviewer-two",
            model: "model-two",
            permissions: undefined,
          },
        },
        sessionId: "parent-session",
      })
      expect(updateEvent).toHaveBeenCalledWith(state.output, "Started merging.")
      expect(merge).toBeInstanceOf(Merge)
      expect(merge.state).toBe(state)
      expect(merge.octokit).toBe(octokit)
      expect(merge.graphql).toBe(graphql)
    })
  })

  describe("createSession", () => {
    test("creates and saves an editor session", async ({
      magiFixture: { magi },
    }) => {
      const { context, merge, updateEvent, updateState } =
        createMergeFixture(magi)
      const createSession = vi
        .spyOn(magi, "createSession")
        .mockResolvedValue("editor-session")

      merge.state.editor = {
        model: "editor-model",
        permissions: "allow",
      }

      await merge.createSession()

      expect(createSession).toHaveBeenCalledWith(
        "parent-session",
        "magi merge #42 editor",
        { model: "editor-model", permissions: "allow" },
        context.abort,
      )
      expect(updateState).toHaveBeenCalledWith(merge.state.output, {
        editor: { sessionId: "editor-session" },
      })
      expect(updateEvent).toHaveBeenNthCalledWith(
        1,
        merge.state.output,
        "Creating editor session.",
      )
      expect(updateEvent).toHaveBeenNthCalledWith(
        2,
        merge.state.output,
        "Finished creating editor session.",
      )
    })

    test("requires editor state", async ({ magiFixture: { magi } }) => {
      const { merge } = createMergeFixture(magi)

      await expect(merge.createSession()).rejects.toThrow("Editor not found.")
    })

    test("rejects an aborted merge before creating a session", async ({
      magiFixture: { magi },
    }) => {
      const { controller, merge } = createMergeFixture(magi)
      const createSession = vi.spyOn(magi, "createSession")

      merge.state.editor = {}
      controller.abort()

      await expect(merge.createSession()).rejects.toThrow("aborted")
      expect(createSession).not.toHaveBeenCalled()
    })
  })

  describe("createReport", () => {
    test("writes editor results to a completed report", async ({
      magiFixture: { magi },
      temporaryDirectory,
    }) => {
      const { getEvents, merge, updateState } = createMergeFixture(magi)

      merge.state.output = temporaryDirectory
      merge.state.editor = {
        outputs: [
          createEditOutput({
            commitMessage: "fix: address review",
            commitSha: "commit-sha",
            filesTouched: ["src/index.ts"],
          }),
        ],
      }
      getEvents.mockResolvedValue([])
      vi.useFakeTimers()
      vi.setSystemTime("2026-07-23T02:00:00.000Z")

      let report: string

      try {
        report = await merge.createReport()
      } finally {
        vi.useRealTimers()
      }

      expect(report).toContain("- **Editor**:")
      expect(report).toContain("  - **Cycle 1**: Replied")
      expect(report).toContain(
        "    - **Commit**: `commit-sha` fix: address review",
      )
      await expect(
        readFile(join(temporaryDirectory, "report.md"), "utf8"),
      ).resolves.toBe(`${report}\n`)
      expect(updateState).toHaveBeenCalledWith(temporaryDirectory, {
        completedAt: "2026-07-23T02:00:00.000Z",
        status: "completed",
      })
    })
  })

  describe("editCycles", () => {
    test("retries changes-requested verdicts until approval", async ({
      magiFixture: { magi },
    }) => {
      const { config, merge, updateEvent } = createMergeFixture(magi)
      const callback = vi
        .fn<(cycle: number) => Promise<"APPROVED" | "CHANGES_REQUESTED">>()
        .mockResolvedValueOnce("CHANGES_REQUESTED")
        .mockResolvedValueOnce("APPROVED")

      config.merge.maxThreadResolutionCycles = 2

      await merge.editCycles(callback)

      expect(callback).toHaveBeenNthCalledWith(1, 1)
      expect(callback).toHaveBeenNthCalledWith(2, 2)
      expect(updateEvent).toHaveBeenCalledWith(
        merge.state.output,
        "Attempt 1 failed to edit cycles. Retrying...",
      )
    })

    test("blocks after reaching the maximum edit cycles", async ({
      magiFixture: { magi },
    }) => {
      const { config, merge } = createMergeFixture(magi)
      const callback = vi
        .fn<(cycle: number) => Promise<"CHANGES_REQUESTED">>()
        .mockResolvedValue("CHANGES_REQUESTED")

      config.merge.maxThreadResolutionCycles = 1

      await expect(merge.editCycles(callback)).rejects.toThrow(
        "Reached maximum edit cycles.",
      )
      expect(callback).toHaveBeenCalledOnce()
    })
  })

  describe("postReplies", () => {
    test("posts each editor response with the editor account", async ({
      magiFixture: { magi },
    }) => {
      const { context, merge, octokit, octokitMocks, updateEvent } =
        createMergeFixture(magi)
      const createOctokit = vi
        .spyOn(magi, "createOctokit")
        .mockResolvedValue(octokit)

      octokitMocks.createReplyForReviewComment.mockResolvedValue({})
      merge.state.editor = {
        account: "editor",
        outputs: [
          createEditOutput({
            responses: [
              {
                action: "FIXED",
                body: "Fixed in the latest commit.",
                commentId: 101,
              },
            ],
          }),
        ],
      }

      await merge.postReplies()

      expect(createOctokit).toHaveBeenCalledWith(
        merge.config,
        context.abort,
        "editor",
      )
      expect(octokitMocks.createReplyForReviewComment).toHaveBeenCalledWith({
        body: "Fixed in the latest commit.",
        comment_id: 101,
        owner: "magi-ai",
        pull_number: 42,
        repo: "opencode-magi",
      })
      expect(updateEvent).toHaveBeenNthCalledWith(
        1,
        merge.state.output,
        "Posting editor replies.",
      )
      expect(updateEvent).toHaveBeenNthCalledWith(
        2,
        merge.state.output,
        "Finished posting editor replies.",
      )
    })

    test("requires editor output", async ({ magiFixture: { magi } }) => {
      const { merge } = createMergeFixture(magi)

      await expect(merge.postReplies()).rejects.toThrow(
        "Editor output not found.",
      )
    })

    test("returns without an API client when there are no responses", async ({
      magiFixture: { magi },
    }) => {
      const { merge, updateEvent } = createMergeFixture(magi)
      const createOctokit = vi.spyOn(magi, "createOctokit")

      merge.state.editor = { outputs: [createEditOutput()] }

      await merge.postReplies()

      expect(createOctokit).not.toHaveBeenCalled()
      expect(updateEvent).not.toHaveBeenCalled()
    })

    test("requires an editor account before posting", async ({
      magiFixture: { magi },
    }) => {
      const { merge } = createMergeFixture(magi)

      merge.state.editor = {
        outputs: [
          createEditOutput({
            responses: [
              { action: "ASK", body: "Please clarify.", commentId: 101 },
            ],
          }),
        ],
      }

      await expect(merge.postReplies()).rejects.toThrow(
        "Editor account not found.",
      )
    })
  })

  describe("fetchMergeContext", () => {
    test("fetches merge context and inline comment targets", async ({
      magiFixture: { magi },
    }) => {
      const { exec, merge } = createMergeFixture(magi)

      merge.state.editor = { outputs: [createEditOutput()] }
      merge.state.reviewers = { one: { status: "initial" } }
      merge.state.pr!.metadata = createMetadata()
      merge.state.worktree = { path: "/tmp/worktree" }
      exec.mockImplementation((command) => {
        if (command.includes("git diff "))
          return Promise.resolve(
            [
              "diff --git a/src/index.ts b/src/index.ts",
              "+++ b/src/index.ts",
              "@@ -1,1 +1,2 @@",
              " line one",
              "+line two",
            ].join("\n"),
          )

        return Promise.resolve("")
      })

      await merge.fetchMergeContext()

      expect(merge.state.pr?.comments).toStrictEqual([])
      expect(merge.state.pr?.issues).toStrictEqual([])
      expect(merge.state.pr?.threads).toStrictEqual([])
      expect(merge.state.pr?.inlineCommentTargets).toStrictEqual({
        "base-sha": { "src/index.ts": [1, 2] },
      })
    })

    test("requires editor output", async ({ magiFixture: { magi } }) => {
      const { merge } = createMergeFixture(magi)

      await expect(merge.fetchMergeContext()).rejects.toThrow(
        "Editor output not found.",
      )
    })

    test("includes synthetic new findings and editor replies during a dry run", async ({
      magiFixture: { magi },
    }) => {
      const { exec, merge } = createMergeFixture(magi)

      merge.state.dryRun = true
      merge.state.editor = {
        outputs: [
          createEditOutput({
            responses: [{ action: "FIXED", body: "Fixed.", commentId: -1 }],
          }),
        ],
      }
      merge.state.reviewers = {
        one: {
          outputs: [
            {
              newFindings: [
                {
                  body: "Finding.",
                  line: 2,
                  path: "src/index.ts",
                  state: "accepted",
                },
              ],
              verdict: "CHANGES_REQUESTED",
            },
          ],
        },
      }
      merge.state.pr!.metadata = createMetadata()
      merge.state.worktree = { path: "/tmp/worktree" }
      exec.mockResolvedValue("")

      await merge.fetchMergeContext()

      expect(merge.state.pr?.threads).toStrictEqual([
        expect.objectContaining({
          comments: [
            expect.objectContaining({
              body: expect.stringContaining("Finding."),
            }),
            expect.objectContaining({ body: "Fixed." }),
          ],
          id: "dry-run:one:1",
        }),
      ])
    })
  })

  describe("markRepliedReviewers", () => {
    test("marks the reviewer owning a replied thread", async ({
      magiFixture: { magi },
    }) => {
      const { merge, updateState } = createMergeFixture(magi)
      const body = [
        "Finding.",
        marker.stringify({
          command: "review",
          reviewer: "one",
          verdict: "CHANGES_REQUESTED",
        }),
      ].join("\n\n")

      merge.state.editor = {
        outputs: [
          createEditOutput({
            responses: [{ action: "FIXED", body: "Fixed.", commentId: 101 }],
          }),
        ],
      }
      merge.state.pr!.threads = [
        {
          comments: [{ body, databaseId: 101 }],
          id: "thread-1",
          isResolved: false,
        } as unknown as PullRequestReviewThread,
      ]
      merge.state.reviewers = { one: {}, two: {} }

      await merge.markRepliedReviewers()

      expect(updateState).toHaveBeenCalledWith(merge.state.output, {
        reviewers: {
          one: { status: "reply" },
          two: { status: "skip" },
        },
      })
    })

    describe.each([
      ["editor output", "Editor output not found."],
      ["threads", "PR threads not found."],
      ["reviewers", "Reviewers not found."],
    ])("requires %s", (target, message) => {
      test("rejects incomplete state", async ({ magiFixture: { magi } }) => {
        const { merge } = createMergeFixture(magi)

        if (target !== "editor output")
          merge.state.editor = { outputs: [createEditOutput()] }
        if (target === "reviewers") merge.state.pr!.threads = []

        await expect(merge.markRepliedReviewers()).rejects.toThrow(message)
      })
    })

    test("requires a response matching a review thread", async ({
      magiFixture: { magi },
    }) => {
      const { merge } = createMergeFixture(magi)

      merge.state.editor = {
        outputs: [
          createEditOutput({
            responses: [{ action: "ASK", body: "Question.", commentId: 999 }],
          }),
        ],
      }
      merge.state.pr!.threads = []
      merge.state.reviewers = { one: {} }

      await expect(merge.markRepliedReviewers()).rejects.toThrow(
        "No replied reviewers found.",
      )
    })

    test("matches multi-mode reviewers by thread author", async ({
      magiFixture: { magi },
    }) => {
      const { config, merge, updateState } = createMergeFixture(magi)

      config.mode = "multi"
      merge.state.editor = {
        outputs: [
          createEditOutput({
            responses: [{ action: "FIXED", body: "Fixed.", commentId: 101 }],
          }),
        ],
      }
      merge.state.pr!.threads = [
        {
          comments: [{ author: { login: "reviewer-two" }, databaseId: 101 }],
          id: "thread-1",
          isResolved: false,
        } as PullRequestReviewThread,
      ]
      merge.state.reviewers = {
        one: { account: "reviewer-one" },
        two: { account: "reviewer-two" },
      }

      await merge.markRepliedReviewers()

      expect(updateState).toHaveBeenCalledWith(merge.state.output, {
        reviewers: {
          one: { status: "skip" },
          two: { status: "reply" },
        },
      })
    })
  })

  describe("edit", () => {
    test("records an editor response without pushing changes", async ({
      magiFixture: { magi },
    }) => {
      const { createAgentFile, exec, graphqlMocks, merge, updateState } =
        createMergeFixture(magi)
      const output = createEditOutput({
        responses: [
          {
            action: "DISAGREE",
            body: "No code change is needed.",
            commentId: 101,
          },
        ],
      })
      const prompt = {
        create: vi.fn().mockResolvedValue("edit-task"),
        parse: vi.fn().mockReturnValue(output),
        repair: vi.fn(),
        validate: vi.fn().mockReturnValue(true),
      }

      merge.state.editor = {
        author: { email: "editor@example.com", name: "Editor" },
        sessionId: "editor-session",
      }
      merge.state.worktree = { path: "/tmp/worktree" }
      graphqlMocks.paginate.mockResolvedValue({
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                {
                  comments: {
                    nodes: [{ body: "Please fix.", databaseId: 101 }],
                  },
                  id: "thread-1",
                  isResolved: false,
                },
              ],
            },
          },
        },
      })
      vi.spyOn(Prompt, "init").mockResolvedValue(prompt as unknown as Prompt)
      vi.spyOn(magi, "promptSession").mockResolvedValue("raw-editor-output")

      await expect(merge.edit()).resolves.toBeFalsy()
      expect(exec).toHaveBeenCalledWith("git config user.name 'Editor'", {
        cwd: "/tmp/worktree",
        signal: merge.context.abort,
      })
      expect(createAgentFile).toHaveBeenCalledWith(
        merge.state.output,
        "edit",
        "editor",
        "raw-editor-output",
        1,
        1,
      )
      expect(updateState).toHaveBeenCalledWith(merge.state.output, {
        editor: { outputs: [output] },
      })
    })

    describe.each([
      ["session", "Editor session ID not found."],
      ["author", "Editor author not found."],
      ["worktree", "PR worktree not found."],
    ])("requires editor %s", (target, message) => {
      test("rejects incomplete state", async ({ magiFixture: { magi } }) => {
        const { merge } = createMergeFixture(magi)

        merge.state.editor = {
          author:
            target === "author"
              ? undefined
              : { email: "editor@example.com", name: "Editor" },
          sessionId: target === "session" ? undefined : "editor-session",
        }

        if (target !== "worktree")
          merge.state.worktree = { path: "/tmp/worktree" }

        await expect(merge.edit()).rejects.toThrow(message)
      })
    })

    test("blocks when no editable threads remain", async ({
      magiFixture: { magi },
    }) => {
      const { merge } = createMergeFixture(magi)

      merge.state.editor = {
        author: { email: "editor@example.com", name: "Editor" },
        sessionId: "editor-session",
      }
      merge.state.worktree = { path: "/tmp/worktree" }

      await expect(merge.edit()).rejects.toThrow(
        "No editable review threads found.",
      )
    })

    test("ignores null and resolved review threads", async ({
      magiFixture: { magi },
    }) => {
      const { graphqlMocks, merge } = createMergeFixture(magi)

      merge.state.editor = {
        author: { email: "editor@example.com", name: "Editor" },
        sessionId: "editor-session",
      }
      merge.state.worktree = { path: "/tmp/worktree" }
      graphqlMocks.paginate.mockResolvedValue({
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                null,
                { comments: { nodes: [] }, id: "thread-1", isResolved: true },
              ],
            },
          },
        },
      })

      await expect(merge.edit()).rejects.toThrow(
        "No editable review threads found.",
      )
    })

    test("stops retrying when the editor session is blocked", async ({
      magiFixture: { magi },
    }) => {
      const { graphqlMocks, merge, updateEvent } = createMergeFixture(magi)
      const error = new MagiError("blocked", "Editor requested input.")

      merge.config.output.repairAttempts = 2
      merge.state.editor = {
        author: { email: "editor@example.com", name: "Editor" },
        sessionId: "editor-session",
      }
      merge.state.worktree = { path: "/tmp/worktree" }
      graphqlMocks.paginate.mockResolvedValue({
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                {
                  comments: { nodes: [{ databaseId: 101 }] },
                  id: "thread-1",
                  isResolved: false,
                },
              ],
            },
          },
        },
      })
      vi.spyOn(Prompt, "init").mockResolvedValue({
        create: vi.fn().mockResolvedValue("edit-task"),
      } as unknown as Prompt)

      const promptSession = vi
        .spyOn(magi, "promptSession")
        .mockRejectedValue(error)

      await expect(merge.edit()).rejects.toThrow(error)
      expect(promptSession).toHaveBeenCalledOnce()
      expect(updateEvent).not.toHaveBeenCalledWith(
        merge.state.output,
        "Attempt 1 failed to edit. Retrying...",
      )
    })

    test("rejects an edited output that does not match worktree HEAD", async ({
      magiFixture: { magi },
    }) => {
      const { exec, graphqlMocks, merge } = createMergeFixture(magi)
      const output = createEditOutput({
        commitMessage: "fix review",
        commitSha: "reported-sha",
        filesTouched: ["src/index.ts"],
        mode: "EDITED",
        responses: [{ action: "FIXED", body: "Fixed.", commentId: 101 }],
      })
      const prompt = {
        create: vi.fn().mockResolvedValue("edit-task"),
        parse: vi.fn().mockReturnValue(output),
        repair: vi.fn(),
        validate: vi.fn().mockReturnValue(true),
      }

      merge.config.output.repairAttempts = 1
      merge.state.editor = {
        author: { email: "editor@example.com", name: "Editor" },
        sessionId: "editor-session",
      }
      merge.state.worktree = { path: "/tmp/worktree" }
      graphqlMocks.paginate.mockResolvedValue({
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                {
                  comments: { nodes: [{ databaseId: 101 }] },
                  id: "thread-1",
                  isResolved: false,
                },
              ],
            },
          },
        },
      })
      exec.mockImplementation((command) =>
        Promise.resolve(command === "git rev-parse HEAD" ? "actual-sha" : ""),
      )
      vi.spyOn(Prompt, "init").mockResolvedValue(prompt as unknown as Prompt)
      vi.spyOn(magi, "promptSession").mockResolvedValue("raw-editor-output")

      await expect(merge.edit()).rejects.toThrow("Invalid output for editor.")
    })
  })

  describe("resolveConflict", () => {
    test("blocks when the worktree has no merge conflicts", async ({
      magiFixture: { magi },
    }) => {
      const { exec, merge } = createMergeFixture(magi)

      merge.state.editor = {
        author: { email: "editor@example.com", name: "Editor" },
        sessionId: "editor-session",
      }
      merge.state.pr!.metadata = createMetadata()
      merge.state.worktree = { path: "/tmp/worktree" }

      await expect(merge.resolveConflict()).rejects.toThrow(
        "No merge conflicts found in worktree.",
      )
      expect(exec).toHaveBeenCalledWith(
        "git merge --no-commit --no-ff FETCH_HEAD",
        { cwd: "/tmp/worktree", signal: merge.context.abort },
      )
      expect(exec).toHaveBeenCalledWith("git merge --abort", {
        cwd: "/tmp/worktree",
        signal: merge.context.abort,
      })
    })

    test("requires pull request metadata", async ({
      magiFixture: { magi },
    }) => {
      const { merge } = createMergeFixture(magi)

      merge.state.editor = {
        author: { email: "editor@example.com", name: "Editor" },
        sessionId: "editor-session",
      }
      merge.state.worktree = { path: "/tmp/worktree" }

      await expect(merge.resolveConflict()).rejects.toThrow(
        "PR metadata not found.",
      )
    })

    test("blocks when a failed merge reports no conflicted files", async ({
      magiFixture: { magi },
    }) => {
      const { exec, merge } = createMergeFixture(magi)

      merge.state.editor = {
        author: { email: "editor@example.com", name: "Editor" },
        sessionId: "editor-session",
      }
      merge.state.pr!.metadata = createMetadata()
      merge.state.worktree = { path: "/tmp/worktree" }
      exec.mockImplementation((command) => {
        if (command.includes("git merge --no-commit"))
          return Promise.reject(new Error("merge failed"))

        return Promise.resolve("")
      })

      await expect(merge.resolveConflict()).rejects.toThrow(
        "No merge conflicts found in worktree.",
      )
      expect(exec).toHaveBeenCalledWith("git merge --abort", {
        cwd: "/tmp/worktree",
        signal: merge.context.abort,
      })
    })

    describe.each([
      ["invalid output", "invalid"],
      ["remaining conflicts", "conflicts"],
      ["missing commit", "commit"],
      ["non-merge commit", "parents"],
    ])("blocks conflict resolution with %s", (_label, failure) => {
      test("rejects an incomplete resolution", async ({
        magiFixture: { magi },
      }) => {
        const { exec, merge, updateEvent } = createMergeFixture(magi)
        const prompt = {
          create: vi.fn().mockResolvedValue("conflict-task"),
          parse: vi.fn().mockReturnValue({}),
          repair: vi.fn(),
          validate: vi.fn().mockReturnValue(failure !== "invalid"),
        }

        let conflictChecks = 0

        merge.config.output.repairAttempts = 1
        merge.state.editor = {
          author: { email: "editor@example.com", name: "Editor" },
          sessionId: "editor-session",
        }
        merge.state.pr!.metadata = createMetadata()
        merge.state.worktree = { path: "/tmp/worktree" }
        exec.mockImplementation((command) => {
          if (command.includes("git merge --no-commit"))
            return Promise.reject(new Error("merge conflict"))

          if (command.includes("git diff --name-only")) {
            conflictChecks += 1

            return Promise.resolve(
              conflictChecks === 1 || failure === "conflicts"
                ? "src/index.ts"
                : "",
            )
          }

          if (command === "git rev-parse HEAD")
            return Promise.resolve(
              failure === "commit" ? "head-sha" : "resolved-sha",
            )
          if (command.includes("git rev-list"))
            return Promise.resolve(
              failure === "parents"
                ? "resolved-sha parent-sha"
                : "resolved-sha parent-one parent-two",
            )

          return Promise.resolve("")
        })
        vi.spyOn(Prompt, "init").mockResolvedValue(prompt as unknown as Prompt)
        vi.spyOn(magi, "promptSession").mockResolvedValue("editor-output")

        await expect(merge.resolveConflict()).rejects.toThrow(
          "Invalid output for conflict editor.",
        )
        expect(updateEvent).toHaveBeenCalledWith(
          merge.state.output,
          "Attempt 1 failed to resolve conflicts. Retrying...",
        )
      })
    })

    test("saves a dry-run conflict resolution without pushing", async ({
      magiFixture: { magi },
    }) => {
      const { exec, merge, updateEvent } = createMergeFixture(magi)
      const prompt = {
        create: vi.fn().mockResolvedValue("conflict-task"),
        parse: vi.fn().mockReturnValue({}),
        repair: vi.fn().mockResolvedValue("repaired-conflict-task"),
        validate: vi.fn().mockReturnValueOnce(false).mockReturnValue(true),
      }

      let conflictChecks = 0

      merge.config.output.repairAttempts = 2
      merge.state.dryRun = true
      merge.state.editor = {
        author: { email: "editor@example.com", name: "Editor" },
        outputs: [createEditOutput()],
        sessionId: "editor-session",
      }
      merge.state.pr = {
        ...merge.state.pr!,
        files: ["README.md"],
        metadata: createMetadata(),
      }
      merge.state.worktree = { path: "/tmp/worktree" }
      exec.mockImplementation((command) => {
        if (command.includes("git merge --no-commit"))
          return Promise.reject(new Error("merge conflict"))

        if (command.includes("git diff --name-only")) {
          conflictChecks += 1

          return Promise.resolve(conflictChecks === 1 ? "src/index.ts" : "")
        }

        if (command === "git rev-parse HEAD")
          return Promise.resolve("resolved-sha")
        if (command.includes("git rev-list"))
          return Promise.resolve("resolved-sha parent-one parent-two")
        if (command.includes("git log"))
          return Promise.resolve("Resolve conflict")

        return Promise.resolve("")
      })
      vi.spyOn(Prompt, "init").mockResolvedValue(prompt as unknown as Prompt)
      vi.spyOn(magi, "promptSession").mockResolvedValue("editor-output")

      await merge.resolveConflict()

      expect(prompt.repair).toHaveBeenCalledOnce()
      expect(merge.state.pr.metadata?.head.sha).toBe("resolved-sha")
      expect(merge.state.pr.files).toStrictEqual(["README.md", "src/index.ts"])
      expect(updateEvent).toHaveBeenCalledWith(
        merge.state.output,
        "Skipped pushing conflict resolution during dry run.",
      )
    })

    test("stops retrying when the conflict editor session is blocked", async ({
      magiFixture: { magi },
    }) => {
      const { exec, merge, updateEvent } = createMergeFixture(magi)
      const error = new MagiError("blocked", "Editor requested input.")

      merge.config.output.repairAttempts = 2
      merge.state.editor = {
        author: { email: "editor@example.com", name: "Editor" },
        sessionId: "editor-session",
      }
      merge.state.pr!.metadata = createMetadata()
      merge.state.worktree = { path: "/tmp/worktree" }
      exec.mockImplementation((command) => {
        if (command.includes("git merge --no-commit"))
          return Promise.reject(new Error("merge conflict"))
        if (command.includes("git diff --name-only"))
          return Promise.resolve("src/index.ts")

        return Promise.resolve("")
      })
      vi.spyOn(Prompt, "init").mockResolvedValue({
        create: vi.fn().mockResolvedValue("conflict-task"),
      } as unknown as Prompt)

      const promptSession = vi
        .spyOn(magi, "promptSession")
        .mockRejectedValue(error)

      await expect(merge.resolveConflict()).rejects.toThrow(error)
      expect(promptSession).toHaveBeenCalledOnce()
      expect(updateEvent).not.toHaveBeenCalledWith(
        merge.state.output,
        "Attempt 1 failed to resolve conflicts. Retrying...",
      )
    })
  })
})
