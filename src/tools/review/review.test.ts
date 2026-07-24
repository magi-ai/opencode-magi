import type { ToolContext } from "@opencode-ai/plugin"
import type { Octokit } from "octokit"
import type {
  PullRequestChecks,
  PullRequestReview,
  PullRequestReviewThread,
} from "."
import type { Graphql } from "@/graphql"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { test } from "#/fixtures/magi"
import {
  createConfig,
  createMetadata,
  createReviewFixture,
  createState,
} from "#/fixtures/review"
import { Prompt } from "@/prompts"
import { marker } from "@/utils"
import { Review } from "./review"

function createChecks(): PullRequestChecks {
  return { excluded: [], failed: [], passed: [], pending: [] }
}

describe("Review", () => {
  describe("init", () => {
    test("creates a review state and records the start event", async ({
      magiFixture: { magi },
    }) => {
      const config = createConfig()
      const context = {
        abort: new AbortController().signal,
        sessionID: "parent-session",
      } as ToolContext
      const octokit = {} as Octokit
      const graphql = {} as Graphql
      const state = createState()

      config.review.output = "/review-output"
      config.review.operator = "one"
      vi.spyOn(magi, "createOctokit").mockResolvedValue(octokit)
      vi.spyOn(magi, "createGraphql").mockReturnValue(graphql)

      const createStateSpy = vi
        .spyOn(magi, "createState")
        .mockResolvedValue(state)
      const updateEvent = vi.spyOn(magi, "updateEvent").mockResolvedValue()
      const review = await Review.init(42, magi, config, context, {
        dryRun: true,
      })

      expect(createStateSpy).toHaveBeenCalledWith("/review-output/42", {
        command: "review",
        dryRun: true,
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
      expect(updateEvent).toHaveBeenCalledWith(
        state.output,
        "Started reviewing.",
      )
      expect(review).toBeInstanceOf(Review)
      expect(review.state).toBe(state)
      expect(review.octokit).toBe(octokit)
      expect(review.graphql).toBe(graphql)
    })

    test("selects an operator from the pull request number by default", async ({
      magiFixture: { magi },
    }) => {
      const config = createConfig()
      const context = {
        abort: new AbortController().signal,
        sessionID: "parent-session",
      } as ToolContext
      const state = createState()
      const createStateSpy = vi
        .spyOn(magi, "createState")
        .mockResolvedValue(state)

      vi.spyOn(magi, "createOctokit").mockResolvedValue({} as Octokit)
      vi.spyOn(magi, "createGraphql").mockReturnValue({} as Graphql)
      vi.spyOn(magi, "updateEvent").mockResolvedValue()

      await Review.init(4, magi, config, context, { dryRun: false })

      expect(createStateSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ operator: config.review.reviewers![1] }),
      )
    })
  })

  describe("cleanup", () => {
    test("marks an aborted active review as cancelled", async ({
      magiFixture: { magi },
    }) => {
      const { controller, review, updateState } = createReviewFixture(magi)

      controller.abort()
      vi.useFakeTimers()
      vi.setSystemTime("2026-07-23T01:00:00.000Z")

      try {
        await review.cleanup()
      } finally {
        vi.useRealTimers()
      }

      expect(updateState).toHaveBeenCalledWith(review.state.output, {
        completedAt: "2026-07-23T01:00:00.000Z",
        status: "cancelled",
      })
    })

    test("deletes a worktree without changing a non-aborted review", async ({
      magiFixture: { magi },
    }) => {
      const { review, updateState } = createReviewFixture(magi)
      const deleteWorktree = vi
        .spyOn(magi, "deleteWorktree")
        .mockResolvedValue(1)

      review.state.worktree = { path: "/tmp/worktree" }

      await review.cleanup()

      expect(updateState).not.toHaveBeenCalled()
      expect(deleteWorktree).toHaveBeenCalledWith("/tmp/worktree")
    })

    test("leaves an aborted completed review status unchanged", async ({
      magiFixture: { magi },
    }) => {
      const { controller, review, updateState } = createReviewFixture(magi)

      review.state.status = "completed"
      controller.abort()

      await review.cleanup()

      expect(updateState).not.toHaveBeenCalled()
    })
  })

  describe("updateState", () => {
    test("updates and replaces the current state", async ({
      magiFixture: { magi },
    }) => {
      const { review, updateState } = createReviewFixture(magi)

      await review.updateState({ status: "running" })

      expect(updateState).toHaveBeenCalledWith(review.state.output, {
        status: "running",
      })
      expect(review.state.status).toBe("running")
    })
  })

  describe("updateEvent", () => {
    test("records an event in the review output", async ({
      magiFixture: { magi },
    }) => {
      const { review, updateEvent } = createReviewFixture(magi)

      await review.updateEvent("Review event.")

      expect(updateEvent).toHaveBeenCalledWith(
        review.state.output,
        "Review event.",
      )
    })
  })

  describe("getEvents", () => {
    test("returns events from the review output", async ({
      magiFixture: { magi },
    }) => {
      const { getEvents, review } = createReviewFixture(magi)
      const events = [
        { createdAt: "2026-07-23T00:00:00.000Z", message: "Started." },
      ]

      getEvents.mockResolvedValue(events)

      await expect(review.getEvents()).resolves.toBe(events)
      expect(getEvents).toHaveBeenCalledWith(review.state.output)
    })
  })

  describe("createAgentFile", () => {
    test("creates an agent file in the review output", async ({
      magiFixture: { magi },
    }) => {
      const { createAgentFile, review } = createReviewFixture(magi)

      await review.createAgentFile("review", "one", "content", 2, 3)

      expect(createAgentFile).toHaveBeenCalledWith(
        review.state.output,
        "review",
        "one",
        "content",
        2,
        3,
      )
    })
  })

  describe("createSessions", () => {
    test("creates reviewer and operator sessions and saves their IDs", async ({
      magiFixture: { magi },
    }) => {
      const { context, review, updateState } = createReviewFixture(magi)
      const createSession = vi
        .spyOn(magi, "createSession")
        .mockResolvedValueOnce("reviewer-one-session")
        .mockResolvedValueOnce("reviewer-two-session")
        .mockResolvedValueOnce("operator-session")

      review.state.reviewers = {
        one: { model: "model-one", permissions: "allow" },
        two: { model: "model-two", permissions: "deny" },
      }
      review.state.operator = { model: "operator-model", permissions: "ask" }

      await review.createSessions()

      expect(createSession).toHaveBeenCalledTimes(3)
      expect(createSession).toHaveBeenCalledWith(
        "parent-session",
        "magi review #42 one",
        { model: "model-one", permissions: "allow" },
        context.abort,
      )
      expect(createSession).toHaveBeenCalledWith(
        "parent-session",
        "magi review #42 two",
        { model: "model-two", permissions: "deny" },
        context.abort,
      )
      expect(createSession).toHaveBeenCalledWith(
        "parent-session",
        "magi review #42 operator",
        { model: "operator-model", permissions: "ask" },
        context.abort,
      )
      expect(updateState).toHaveBeenCalledWith(review.state.output, {
        operator: { sessionId: "operator-session" },
        reviewers: {
          one: { sessionId: "reviewer-one-session" },
          two: { sessionId: "reviewer-two-session" },
        },
      })
    })

    test("rejects an aborted review before creating sessions", async ({
      magiFixture: { magi },
    }) => {
      const { controller, review } = createReviewFixture(magi)
      const createSession = vi.spyOn(magi, "createSession")

      controller.abort()

      await expect(review.createSessions()).rejects.toThrow("aborted")
      expect(createSession).not.toHaveBeenCalled()
    })

    test("requires reviewer state", async ({ magiFixture: { magi } }) => {
      const { review } = createReviewFixture(magi)

      await expect(review.createSessions()).rejects.toThrow(
        "Reviewers not found.",
      )
    })

    test("requires operator state", async ({ magiFixture: { magi } }) => {
      const { review } = createReviewFixture(magi)

      review.state.reviewers = {}

      await expect(review.createSessions()).rejects.toThrow(
        "Operator not found.",
      )
    })
  })

  describe("createWorktree", () => {
    test("creates and saves a worktree", async ({ magiFixture: { magi } }) => {
      const { config, context, review, updateEvent, updateState } =
        createReviewFixture(magi)
      const worktree = { branch: "magi/review-42", path: "/tmp/worktree" }
      const createWorktree = vi
        .spyOn(magi, "createWorktree")
        .mockResolvedValue(worktree)

      await review.createWorktree()

      expect(createWorktree).toHaveBeenCalledWith(
        config.review.worktree,
        42,
        review.state.id,
        context.abort,
      )
      expect(updateState).toHaveBeenCalledWith(review.state.output, {
        worktree,
      })
      expect(updateEvent).toHaveBeenNthCalledWith(
        1,
        review.state.output,
        "Creating worktree.",
      )
      expect(updateEvent).toHaveBeenNthCalledWith(
        2,
        review.state.output,
        "Finished creating worktree.",
      )
    })

    test("rejects an aborted review before creating a worktree", async ({
      magiFixture: { magi },
    }) => {
      const { controller, review } = createReviewFixture(magi)
      const createWorktree = vi.spyOn(magi, "createWorktree")

      controller.abort()

      await expect(review.createWorktree()).rejects.toThrow("aborted")
      expect(createWorktree).not.toHaveBeenCalled()
    })
  })

  describe("resolveVerdict", () => {
    test("resolves a closed majority", async ({ magiFixture: { magi } }) => {
      const { review, updateEvent, updateState } = createReviewFixture(magi)

      review.state.reviewers = {
        one: { outputs: [{ verdict: "CLOSED" }] },
        three: { outputs: [{ verdict: "APPROVED" }] },
        two: { outputs: [{ verdict: "CLOSED" }] },
      }

      await expect(review.resolveVerdict()).resolves.toBe("CLOSED")
      expect(updateState).toHaveBeenCalledWith(review.state.output, {
        pr: { verdict: "CLOSED" },
      })
      expect(updateEvent).toHaveBeenCalledWith(
        review.state.output,
        "Final verdict is CLOSED.",
      )
    })

    test("resolves an approved majority", async ({ magiFixture: { magi } }) => {
      const { review } = createReviewFixture(magi)

      review.state.reviewers = {
        one: { outputs: [{ verdict: "APPROVED" }] },
        three: { outputs: [{ verdict: "CHANGES_REQUESTED" }] },
        two: { outputs: [{ verdict: "APPROVED" }] },
      }

      await expect(review.resolveVerdict()).resolves.toBe("APPROVED")
    })

    test("requests changes without an approved majority", async ({
      magiFixture: { magi },
    }) => {
      const { review } = createReviewFixture(magi)

      review.state.reviewers = {
        one: { outputs: [{ verdict: "APPROVED" }] },
        three: { outputs: [{ verdict: "CLOSED" }] },
        two: { outputs: [{ verdict: "CHANGES_REQUESTED" }] },
      }

      await expect(review.resolveVerdict()).resolves.toBe("CHANGES_REQUESTED")
    })

    test("requires unanimous approval under the unanimous policy", async ({
      magiFixture: { magi },
    }) => {
      const { config, review } = createReviewFixture(magi)

      config.review.merge.approvalPolicy = "unanimous"
      review.state.reviewers = {
        one: { outputs: [{ verdict: "APPROVED" }] },
        three: { outputs: [{ verdict: "APPROVED" }] },
        two: { outputs: [{ verdict: "CHANGES_REQUESTED" }] },
      }

      await expect(review.resolveVerdict()).resolves.toBe("CHANGES_REQUESTED")
    })

    test("approves a unanimous verdict", async ({ magiFixture: { magi } }) => {
      const { config, review } = createReviewFixture(magi)

      config.review.merge.approvalPolicy = "unanimous"
      review.state.reviewers = {
        one: { outputs: [{ verdict: "APPROVED" }] },
        three: { outputs: [{ verdict: "APPROVED" }] },
        two: { outputs: [{ verdict: "APPROVED" }] },
      }

      await expect(review.resolveVerdict()).resolves.toBe("APPROVED")
    })

    test("requires configured reviewers", async ({ magiFixture: { magi } }) => {
      const { config, review } = createReviewFixture(magi)

      config.review.reviewers = []

      await expect(review.resolveVerdict()).rejects.toThrow(
        "No reviewers configured.",
      )
    })

    test("requires reviewer state", async ({ magiFixture: { magi } }) => {
      const { review } = createReviewFixture(magi)

      await expect(review.resolveVerdict()).rejects.toThrow(
        "Reviewers not found.",
      )
    })

    test("requires an output from every reviewer", async ({
      magiFixture: { magi },
    }) => {
      const { review } = createReviewFixture(magi)

      review.state.reviewers = { one: {} }

      await expect(review.resolveVerdict()).rejects.toThrow(
        "No output found for reviewer one.",
      )
    })
  })

  describe("checkPr", () => {
    test("checks and saves pull request metadata and files", async ({
      magiFixture: { magi },
    }) => {
      const { octokitMocks, review } = createReviewFixture(magi)

      octokitMocks.paginate.mockResolvedValue([{ filename: "src/index.ts" }])

      await review.checkPr()

      expect(review.state.status).toBe("running")
      expect(review.state.pr?.metadata).toStrictEqual(createMetadata())
      expect(review.state.pr?.files).toStrictEqual(["src/index.ts"])
      expect(octokitMocks.get).toHaveBeenCalledWith({
        owner: "magi-ai",
        pull_number: 42,
        repo: "opencode-magi",
      })
    })

    test("reports every configured safety violation", async ({
      magiFixture: { magi },
    }) => {
      const { config, octokitMocks, review } = createReviewFixture(magi)
      const metadata = createMetadata()

      metadata.changed_files = 2
      metadata.labels = []
      metadata.user.login = "untrusted"
      config.review.safety.allowAuthors = ["trusted"]
      config.review.safety.blockedPaths = ["secrets/**"]
      config.review.safety.maxChangedFiles = 1
      config.review.safety.requiredLabels = ["reviewable"]
      octokitMocks.get.mockResolvedValue({ data: metadata })
      octokitMocks.paginate.mockResolvedValue([
        { filename: "secrets/token.txt" },
      ])

      await expect(review.checkPr()).rejects.toThrow(
        "PR is safety blocked. Author is not allowed: untrusted. Required labels missing: reviewable. Changed files exceed limit: 2 > 1. Blocked paths changed: secrets/token.txt.",
      )
    })

    test("blocks a multi-mode reviewer that authored the pull request", async ({
      magiFixture: { magi },
    }) => {
      const { config, octokitMocks, review } = createReviewFixture(magi)
      const metadata = createMetadata()

      config.mode = "multi"
      metadata.user.login = "reviewer-one"
      review.state.reviewers = {
        one: { account: "reviewer-one" },
        two: { account: "reviewer-two" },
      }
      octokitMocks.get.mockResolvedValue({ data: metadata })
      octokitMocks.paginate.mockResolvedValue([])

      await expect(review.checkPr()).rejects.toThrow(
        "Multi mode accounts reviewer-one cannot review because they opened the pull request.",
      )
    })

    test("blocks a closed pull request", async ({ magiFixture: { magi } }) => {
      const { octokitMocks, review } = createReviewFixture(magi)
      const metadata = createMetadata()

      metadata.state = "closed"
      octokitMocks.get.mockResolvedValue({ data: metadata })

      await expect(review.checkPr()).rejects.toThrow("PR is not open.")
    })

    test("blocks a draft pull request", async ({ magiFixture: { magi } }) => {
      const { octokitMocks, review } = createReviewFixture(magi)
      const metadata = createMetadata()

      metadata.draft = true
      octokitMocks.get.mockResolvedValue({ data: metadata })

      await expect(review.checkPr()).rejects.toThrow("PR is a draft.")
    })

    test("blocks the single-mode account from reviewing its own pull request", async ({
      magiFixture: { magi },
    }) => {
      const { config, octokitMocks, review } = createReviewFixture(magi)
      const metadata = createMetadata()

      metadata.user.login = config.account!
      octokitMocks.get.mockResolvedValue({ data: metadata })

      await expect(review.checkPr()).rejects.toThrow(
        `Single mode account ${config.account} cannot review because it opened the pull request.`,
      )
    })
  })

  describe("checkExistingReviews", () => {
    test("marks reviewers without existing reviews for initial review", async ({
      magiFixture: { magi },
    }) => {
      const { review } = createReviewFixture(magi)

      review.state.pr!.metadata = createMetadata()

      await expect(review.checkExistingReviews()).resolves.toBeFalsy()
      expect(review.state.reviewers).toStrictEqual({
        one: { account: "reviewer-one", status: "initial" },
        three: { account: "reviewer-three", status: "initial" },
        two: { account: "reviewer-two", status: "initial" },
      })
    })

    test("reuses a current marked review in single mode", async ({
      magiFixture: { magi },
    }) => {
      const { octokitMocks, review } = createReviewFixture(magi)

      review.config.review.reviewers = review.config.review.reviewers!.slice(
        0,
        1,
      )
      review.state.pr!.metadata = createMetadata()
      octokitMocks.paginate.mockImplementation((request) => {
        if (request === octokitMocks.listReviews)
          return Promise.resolve([
            {
              body: marker.stringify({
                body: encodeURIComponent("Looks good."),
                reviewer: "one",
                verdict: "APPROVED",
              }),
              commit_id: "head-sha",
              html_url: "https://github.com/review/1",
              state: "COMMENTED",
              submitted_at: "2026-07-23T01:00:00.000Z",
              user: { login: "review-bot" },
            },
          ])
        if (request === octokitMocks.listCommits)
          return Promise.resolve([
            {
              commit: { author: { date: "2026-07-23T00:30:00.000Z" } },
              parents: [{}],
            },
          ])

        return Promise.resolve([])
      })

      await expect(review.checkExistingReviews()).resolves.toBeTruthy()
      expect(review.state.reviewers).toStrictEqual({
        one: {
          account: "reviewer-one",
          outputs: [{ verdict: "APPROVED" }],
          review: expect.objectContaining({
            body: "Looks good.",
            state: "APPROVED",
          }),
          status: "skip",
        },
      })
    })

    test("rereviews a current review after a new user reply", async ({
      magiFixture: { magi },
    }) => {
      const { graphqlMocks, octokitMocks, review } = createReviewFixture(magi)

      review.config.mode = "multi"
      review.config.review.reviewers = review.config.review.reviewers!.slice(
        0,
        1,
      )
      review.state.pr!.metadata = createMetadata()
      octokitMocks.paginate.mockImplementation((request) => {
        if (request === octokitMocks.listReviews)
          return Promise.resolve([
            {
              body: "",
              commit_id: "head-sha",
              state: "APPROVED",
              submitted_at: "2026-07-23T01:00:00.000Z",
              user: { login: "reviewer-one" },
            },
          ])
        if (request === octokitMocks.listCommits)
          return Promise.resolve([
            {
              commit: { author: { date: "2026-07-23T00:30:00.000Z" } },
              parents: [{}],
            },
          ])

        return Promise.resolve([])
      })
      graphqlMocks.paginate.mockResolvedValue({
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                {
                  comments: {
                    nodes: [
                      {
                        author: { login: "reviewer-one" },
                        createdAt: "2026-07-23T01:00:00.000Z",
                      },
                      {
                        author: { login: "octocat" },
                        createdAt: "2026-07-23T02:00:00.000Z",
                      },
                    ],
                  },
                  id: "thread-1",
                  isResolved: false,
                },
              ],
            },
          },
        },
      })

      await expect(review.checkExistingReviews()).resolves.toBeFalsy()
      expect(review.state.reviewers?.one?.status).toBe("rereview")
    })

    test("requires pull request metadata", async ({
      magiFixture: { magi },
    }) => {
      const { review } = createReviewFixture(magi)

      await expect(review.checkExistingReviews()).rejects.toThrow(
        "PR metadata not found.",
      )
    })

    test("requires configured reviewers", async ({ magiFixture: { magi } }) => {
      const { config, review } = createReviewFixture(magi)

      config.review.reviewers = []
      review.state.pr!.metadata = createMetadata()

      await expect(review.checkExistingReviews()).rejects.toThrow(
        "No reviewers configured.",
      )
    })

    test("falls back to an empty body for a malformed single-mode marker", async ({
      magiFixture: { magi },
    }) => {
      const { octokitMocks, review } = createReviewFixture(magi)

      review.config.review.reviewers = review.config.review.reviewers!.slice(
        0,
        1,
      )
      review.state.pr!.metadata = createMetadata()
      octokitMocks.paginate.mockImplementation((request) => {
        if (request === octokitMocks.listReviews)
          return Promise.resolve([
            {
              body: marker.stringify({
                body: "%E0%A4%A",
                reviewer: "one",
                verdict: "CLOSED",
              }),
              commit_id: "previous-sha",
              state: "COMMENTED",
              submitted_at: "2026-07-22T00:00:00.000Z",
              user: { login: "review-bot" },
            },
          ])
        if (request === octokitMocks.listCommits)
          return Promise.resolve([
            {
              commit: { author: { date: "2026-07-23T00:00:00.000Z" } },
              parents: [{}],
            },
          ])

        return Promise.resolve([])
      })

      await expect(review.checkExistingReviews()).resolves.toBeFalsy()
      expect(review.state.reviewers?.one?.review).toStrictEqual(
        expect.objectContaining({ body: "", state: "CLOSED" }),
      )
      expect(review.state.reviewers?.one?.status).toBe("rereview")
    })

    test("recognizes closed review markers in multi mode", async ({
      magiFixture: { magi },
    }) => {
      const { config, octokitMocks, review } = createReviewFixture(magi)

      config.mode = "multi"
      config.review.reviewers = config.review.reviewers!.slice(0, 1)
      review.state.pr!.metadata = createMetadata()
      octokitMocks.paginate.mockImplementation((request) => {
        if (request === octokitMocks.listReviews)
          return Promise.resolve([
            {
              body: "Changes.",
              state: "CHANGES_REQUESTED",
              submitted_at: "2026-07-23T00:40:00.000Z",
              user: { login: "reviewer-one" },
            },
            {
              body: "Dismissed.",
              state: "DISMISSED",
              submitted_at: "2026-07-23T00:50:00.000Z",
              user: { login: "reviewer-one" },
            },
            {
              body: marker.stringify({
                reviewer: "one",
                verdict: "CLOSED",
              }),
              commit_id: "head-sha",
              state: "COMMENTED",
              submitted_at: "2026-07-23T01:00:00.000Z",
              user: { login: "reviewer-one" },
            },
          ])
        if (request === octokitMocks.listCommits)
          return Promise.resolve([
            {
              commit: { author: { date: "2026-07-23T00:30:00.000Z" } },
              parents: [{}],
            },
          ])

        return Promise.resolve([])
      })

      await expect(review.checkExistingReviews()).resolves.toBeTruthy()
      expect(review.state.reviewers?.one?.outputs).toStrictEqual([
        { verdict: "CLOSED" },
      ])
      expect(review.state.reviewers?.one?.review?.state).toBe("CLOSED")
    })
  })

  describe("checkCi", () => {
    test("saves an empty check result when no required checks are reported", async ({
      magiFixture: { magi },
    }) => {
      const { exec, review } = createReviewFixture(magi)

      exec.mockResolvedValue("[]")

      await review.checkCi(false)

      expect(review.state.pr?.checks).toStrictEqual(createChecks())
      expect(exec).toHaveBeenCalledOnce()
    })

    test("classifies excluded, failed, passed, and pending checks", async ({
      magiFixture: { magi },
    }) => {
      const { config, exec, review } = createReviewFixture(magi)

      config.review.checks.exclude = ["ignored"]
      exec.mockImplementation((command) => {
        if (command.includes("pr checks"))
          return Promise.resolve(
            JSON.stringify([
              {
                bucket: "fail",
                link: "https://github.com/actions/runs/1/job/11",
                name: "ignored",
                state: "FAILURE",
                workflow: "CI",
              },
              {
                bucket: "fail",
                link: "https://github.com/actions/runs/1/job/12",
                name: "test",
                state: "FAILURE",
                workflow: "CI",
              },
              {
                bucket: "pass",
                link: "https://github.com/actions/runs/1/job/13",
                name: "lint",
                state: "SUCCESS",
                workflow: "CI",
              },
              {
                bucket: "pending",
                link: "https://github.com/actions/runs/1/job/14",
                name: "build",
                state: "PENDING",
                workflow: "CI",
              },
            ]),
          )

        return Promise.resolve("\u001B[31mfailure\u001B[0m\n\n")
      })

      await review.checkCi(false)

      expect(review.state.pr?.checks).toStrictEqual({
        excluded: [expect.objectContaining({ id: "11", name: "ignored" })],
        failed: [
          expect.objectContaining({ id: "12", log: "failure", name: "test" }),
        ],
        passed: [expect.objectContaining({ id: "13", name: "lint" })],
        pending: [expect.objectContaining({ id: "14", name: "build" })],
      })
    })

    test("supports regular expressions when excluding checks", async ({
      magiFixture: { magi },
    }) => {
      const { config, exec, review } = createReviewFixture(magi)

      config.review.checks.exclude = ["/generated-.+/"]
      exec.mockResolvedValue(
        JSON.stringify([
          {
            bucket: "fail",
            link: "https://github.com/actions/runs/1/job/11",
            name: "generated-docs",
            state: "FAILURE",
            workflow: "CI",
          },
        ]),
      )

      await review.checkCi(false)

      expect(review.state.pr?.checks?.excluded[0]?.name).toBe("generated-docs")
    })

    test("surfaces unexpected GitHub check errors", async ({
      magiFixture: { magi },
    }) => {
      const { exec, review } = createReviewFixture(magi)

      exec.mockRejectedValue(new Error("GitHub unavailable"))

      await expect(review.checkCi(false)).rejects.toThrow("GitHub unavailable")
    })
  })

  describe("classifyChecks", () => {
    test("skips classification when no checks failed", async ({
      magiFixture: { magi },
    }) => {
      const { review, updateEvent, updateState } = createReviewFixture(magi)

      review.state.pr!.checks = createChecks()

      await review.classifyChecks()

      expect(updateEvent).not.toHaveBeenCalled()
      expect(updateState).not.toHaveBeenCalled()
    })

    test("uses majority reviewer votes to classify failed checks", async ({
      magiFixture: { magi },
    }) => {
      const { review, updateEvent } = createReviewFixture(magi)
      const prompt = {
        create: vi.fn().mockResolvedValue("classification-task"),
        parse: vi.fn((raw: string) => ({
          checks: [
            {
              classification:
                raw === "reviewer-one-session" ? "SCOPE_IN" : "SCOPE_OUT",
              comment: `${raw} reason`,
              id: "job-1",
            },
          ],
        })),
        repair: vi.fn(),
        validate: vi.fn().mockReturnValue(true),
      }

      review.state.pr = {
        ...review.state.pr!,
        checks: {
          excluded: [],
          failed: [
            {
              bucket: "fail",
              id: "job-1",
              link: "https://github.com/actions/runs/1/job/1",
              name: "test",
              state: "FAILURE",
              workflow: "CI",
            },
          ],
          passed: [],
          pending: [],
        },
        metadata: createMetadata(),
      }
      review.state.reviewers = {
        one: { sessionId: "reviewer-one-session" },
        three: { sessionId: "reviewer-three-session" },
        two: { sessionId: "reviewer-two-session" },
      }
      review.state.worktree = { path: "/tmp/worktree" }
      vi.spyOn(Prompt, "init").mockResolvedValue(prompt as unknown as Prompt)
      vi.spyOn(magi, "promptSession").mockImplementation((sessionId) =>
        Promise.resolve(sessionId),
      )

      await review.classifyChecks()

      expect(review.state.pr.checks?.failed[0]?.scope).toBeFalsy()
      expect(updateEvent).toHaveBeenCalledWith(
        review.state.output,
        expect.stringContaining(
          "Check test was classified as out of scope by majority vote.",
        ),
      )
    })

    describe.each([
      ["metadata", "PR metadata not found."],
      ["worktree", "PR worktree not found."],
    ])("requires pull request %s", (target, message) => {
      test("rejects incomplete state", async ({ magiFixture: { magi } }) => {
        const { review } = createReviewFixture(magi)

        review.state.pr = {
          ...review.state.pr!,
          checks: {
            excluded: [],
            failed: [
              {
                bucket: "fail",
                id: "job-1",
                link: "https://github.com/actions/runs/1/job/1",
                name: "test",
                state: "FAILURE",
                workflow: "CI",
              },
            ],
            passed: [],
            pending: [],
          },
          metadata: target === "metadata" ? undefined : createMetadata(),
        }

        if (target !== "worktree")
          review.state.worktree = { path: "/tmp/worktree" }

        await expect(review.classifyChecks()).rejects.toThrow(message)
      })
    })

    test("requires a reviewer session for CI classification", async ({
      magiFixture: { magi },
    }) => {
      const { review } = createReviewFixture(magi)
      const prompt = {
        create: vi.fn().mockResolvedValue("classification-task"),
      }

      review.state.pr = {
        ...review.state.pr!,
        checks: {
          excluded: [],
          failed: [
            {
              bucket: "fail",
              id: "job-1",
              link: "https://github.com/actions/runs/1/job/1",
              name: "test",
              state: "FAILURE",
              workflow: "CI",
            },
          ],
          passed: [],
          pending: [],
        },
        metadata: createMetadata(),
      }
      review.state.reviewers = { one: {} }
      review.state.worktree = { path: "/tmp/worktree" }
      vi.spyOn(Prompt, "init").mockResolvedValue(prompt as unknown as Prompt)

      await expect(review.classifyChecks()).rejects.toThrow(
        "No session ID found for reviewer one.",
      )
    })

    test("blocks after invalid CI classification output exhausts retries", async ({
      magiFixture: { magi },
    }) => {
      const { config, review, updateEvent } = createReviewFixture(magi)
      const prompt = {
        create: vi.fn().mockResolvedValue("classification-task"),
        parse: vi.fn().mockReturnValue({}),
        repair: vi.fn(),
        validate: vi.fn().mockReturnValue(false),
      }

      config.output.repairAttempts = 1
      review.state.pr = {
        ...review.state.pr!,
        checks: {
          excluded: [],
          failed: [
            {
              bucket: "fail",
              id: "job-1",
              link: "https://github.com/actions/runs/1/job/1",
              name: "test",
              state: "FAILURE",
              workflow: "CI",
            },
          ],
          passed: [],
          pending: [],
        },
        metadata: createMetadata(),
      }
      review.state.reviewers = { one: { sessionId: "reviewer-one-session" } }
      review.state.worktree = { path: "/tmp/worktree" }
      vi.spyOn(Prompt, "init").mockResolvedValue(prompt as unknown as Prompt)
      vi.spyOn(magi, "promptSession").mockResolvedValue("invalid-output")

      await expect(review.classifyChecks()).rejects.toThrow(
        "Invalid output for reviewer one.",
      )
      expect(updateEvent).toHaveBeenCalledWith(
        review.state.output,
        "Attempt 1 failed to classify CI checks with reviewer one. Retrying...",
      )
    })
  })

  describe("rerunChecks", () => {
    test("moves out-of-scope failures to passed checks during a dry run", async ({
      magiFixture: { magi },
    }) => {
      const { exec, review } = createReviewFixture(magi)
      const check = {
        bucket: "fail",
        id: "job-1",
        link: "https://github.com/actions/runs/1/job/1",
        name: "test",
        scope: false,
        state: "FAILURE",
        workflow: "CI",
      }

      review.state.dryRun = true
      review.state.pr!.checks = {
        excluded: [],
        failed: [check],
        passed: [],
        pending: [],
      }

      await review.rerunChecks()

      expect(review.state.pr?.checks?.failed).toStrictEqual([])
      expect(review.state.pr?.checks?.passed).toStrictEqual([check])
      expect(exec).not.toHaveBeenCalled()
    })

    test("requires pull request checks", async ({ magiFixture: { magi } }) => {
      const { review } = createReviewFixture(magi)

      await expect(review.rerunChecks()).rejects.toThrow("PR checks not found.")
    })

    test("preserves and reports an out-of-scope check that still fails", async ({
      magiFixture: { magi },
    }) => {
      const { config, exec, review, updateEvent } = createReviewFixture(magi)
      const check = {
        bucket: "fail",
        classifieds: { one: { comment: "Not caused here.", scope: false } },
        id: "job-1",
        link: "https://github.com/actions/runs/1/job/1",
        name: "test",
        scope: false,
        state: "FAILURE",
        workflow: "CI",
      }

      config.review.checks.retryFailedJobs = 1
      review.state.pr!.checks = {
        excluded: [],
        failed: [check],
        passed: [],
        pending: [],
      }
      exec.mockImplementation((command) => {
        if (command.includes("pr checks") && command.includes("--json"))
          return Promise.resolve(
            JSON.stringify([
              {
                bucket: "fail",
                link: check.link,
                name: check.name,
                state: "FAILURE",
                workflow: check.workflow,
              },
            ]),
          )
        if (command.includes("run view")) return Promise.resolve("failed log")

        return Promise.resolve("")
      })

      await review.rerunChecks()

      expect(review.state.pr?.checks?.failed[0]).toStrictEqual(
        expect.objectContaining({
          classifieds: check.classifieds,
          scope: false,
        }),
      )
      expect(updateEvent).toHaveBeenCalledWith(
        review.state.output,
        "Reran checks test failed.",
      )
    })
  })

  describe("fetchReviewContext", () => {
    test("fetches context and builds right-side inline comment targets", async ({
      magiFixture: { magi },
    }) => {
      const { exec, review } = createReviewFixture(magi)

      review.state.reviewers = { one: { status: "initial" } }
      review.state.pr!.metadata = createMetadata()
      review.state.worktree = { path: "/tmp/worktree" }
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

      await review.fetchReviewContext()

      expect(review.state.pr?.comments).toStrictEqual([])
      expect(review.state.pr?.issues).toStrictEqual([])
      expect(review.state.pr?.threads).toStrictEqual([])
      expect(review.state.pr?.inlineCommentTargets).toStrictEqual({
        "base-sha": { "src/index.ts": [1, 2] },
      })
    })

    test("requires every diff commit to be available after fetching", async ({
      magiFixture: { magi },
    }) => {
      const { exec, review } = createReviewFixture(magi)

      review.state.reviewers = { one: { status: "initial" } }
      review.state.pr!.metadata = createMetadata()
      review.state.worktree = { path: "/tmp/worktree" }
      exec.mockImplementation((command) => {
        if (command.includes("git cat-file"))
          return Promise.reject(new Error("missing commit"))

        return Promise.resolve("")
      })

      await expect(review.fetchReviewContext()).rejects.toThrow(
        "from commit base-sha is unavailable after fetching base ref main.",
      )
      expect(exec).toHaveBeenCalledWith(
        expect.stringContaining("git fetch"),
        expect.objectContaining({ cwd: "/tmp/worktree" }),
      )
    })

    test("requires a previous commit for rereview diff targets", async ({
      magiFixture: { magi },
    }) => {
      const { review } = createReviewFixture(magi)

      review.state.reviewers = { one: { status: "rereview" } }
      review.state.pr!.metadata = createMetadata()
      review.state.worktree = { path: "/tmp/worktree" }

      await expect(review.fetchReviewContext()).rejects.toThrow(
        "Missing previous review commit for reviewer one.",
      )
    })

    describe.each([
      ["reviewers", "Reviewers not found."],
      ["metadata", "PR metadata not found."],
      ["worktree", "PR worktree not found."],
    ])("requires %s for inline targets", (target, message) => {
      test("rejects incomplete state", async ({ magiFixture: { magi } }) => {
        const { review } = createReviewFixture(magi)

        review.state.reviewers = { one: { status: "initial" } }
        review.state.pr!.metadata = createMetadata()
        review.state.worktree = { path: "/tmp/worktree" }

        if (target === "reviewers") review.state.reviewers = undefined
        if (target === "metadata") review.state.pr!.metadata = undefined
        if (target === "worktree") review.state.worktree = undefined

        await expect(review.fetchReviewContext()).rejects.toThrow(message)
      })
    })

    test("filters null closing issues and comments from context", async ({
      magiFixture: { magi },
    }) => {
      const { exec, graphqlMocks, review } = createReviewFixture(magi)

      review.state.reviewers = { one: { status: "initial" } }
      review.state.pr!.metadata = createMetadata()
      review.state.worktree = { path: "/tmp/worktree" }
      graphqlMocks.paginate.mockImplementation((request) => {
        if (request === graphqlMocks.closingIssues)
          return Promise.resolve({
            repository: {
              pullRequest: {
                closingIssuesReferences: {
                  nodes: [
                    null,
                    {
                      comments: { nodes: [null, { body: "Issue comment" }] },
                      number: 1,
                    },
                  ],
                },
              },
            },
          })

        return Promise.resolve({
          repository: { pullRequest: { reviewThreads: { nodes: [] } } },
        })
      })
      exec.mockResolvedValue("")

      await review.fetchReviewContext()

      expect(review.state.pr?.issues).toStrictEqual([
        { comments: [{ body: "Issue comment" }], number: 1 },
      ])
    })
  })

  describe("review", () => {
    test("skips reviewers whose existing reviews are current", async ({
      magiFixture: { magi },
    }) => {
      const { review, updateEvent } = createReviewFixture(magi)

      review.state.pr = {
        ...review.state.pr!,
        checks: createChecks(),
        metadata: createMetadata(),
        threads: [],
      }
      review.state.reviewers = {
        one: { status: "skip" },
        three: { status: "skip" },
        two: { status: "skip" },
      }
      review.state.worktree = { path: "/tmp/worktree" }

      await review.review()

      expect(updateEvent).toHaveBeenCalledWith(
        review.state.output,
        "Skipping review with reviewer one.",
      )
      expect(updateEvent).toHaveBeenCalledWith(
        review.state.output,
        "Finished reviewing.",
      )
    })

    test("validates and saves reviewer findings and thread actions", async ({
      magiFixture: { magi },
    }) => {
      const { config, review } = createReviewFixture(magi)
      const output = {
        findings: [
          {
            body: "Handle the error.",
            line: 2,
            path: "src/index.ts",
            startLine: 1,
          },
        ],
        followUps: [{ body: "Is this handled?", commentId: 101 }],
        resolves: [{ commentId: 101, threadId: "thread-1" }],
        verdict: "CHANGES_REQUESTED" as const,
      }
      const prompt = {
        create: vi.fn().mockResolvedValue("review-task"),
        parse: vi.fn().mockReturnValue(output),
        repair: vi.fn(),
        validate: vi.fn().mockReturnValue(true),
      }
      const thread = {
        comments: [{ author: { login: "reviewer-one" }, databaseId: 101 }],
        id: "thread-1",
        isResolved: false,
      } as PullRequestReviewThread

      config.mode = "multi"
      config.review.reviewers = config.review.reviewers!.slice(0, 1)
      review.state.pr = {
        ...review.state.pr!,
        checks: createChecks(),
        inlineCommentTargets: {
          "base-sha": { "src/index.ts": [1, 2] },
        },
        metadata: createMetadata(),
        threads: [thread],
      }
      review.state.reviewers = {
        one: { sessionId: "reviewer-one-session", status: "initial" },
      }
      review.state.worktree = { path: "/tmp/worktree" }
      vi.spyOn(Prompt, "init").mockResolvedValue(prompt as unknown as Prompt)
      vi.spyOn(magi, "promptSession").mockResolvedValue("raw-review-output")

      await review.review()

      expect(review.state.reviewers.one?.outputs).toStrictEqual([
        {
          ...output,
          findings: [{ ...output.findings[0], state: "accepted" }],
        },
      ])
    })

    describe.each([
      ["configured reviewers", "No reviewers configured."],
      ["pull request metadata", "PR metadata not found."],
      ["worktree", "PR worktree not found."],
      ["checks", "PR checks not found."],
      ["threads", "PR threads not found."],
      ["reviewer state", "Reviewers not found."],
      ["reviewer session", "No session ID found for reviewer one."],
      [
        "previous review commit",
        "Missing previous review commit for reviewer one.",
      ],
    ])("requires %s", (target, message) => {
      test("rejects incomplete state", async ({ magiFixture: { magi } }) => {
        const { config, review } = createReviewFixture(magi)

        config.review.reviewers = config.review.reviewers!.slice(0, 1)
        review.state.pr = {
          ...review.state.pr!,
          checks: createChecks(),
          metadata: createMetadata(),
          threads: [],
        }
        review.state.reviewers = {
          one: { sessionId: "reviewer-one-session", status: "initial" },
        }
        review.state.worktree = { path: "/tmp/worktree" }

        if (target === "configured reviewers") config.review.reviewers = []
        if (target === "pull request metadata")
          review.state.pr.metadata = undefined
        if (target === "worktree") review.state.worktree = undefined
        if (target === "checks") review.state.pr.checks = undefined
        if (target === "threads") review.state.pr.threads = undefined
        if (target === "reviewer state") review.state.reviewers = undefined
        if (target === "reviewer session")
          review.state.reviewers!.one!.sessionId = undefined
        if (target === "previous review commit")
          review.state.reviewers!.one = {
            sessionId: "reviewer-one-session",
            status: "rereview",
          }

        await expect(review.review()).rejects.toThrow(message)
      })
    })

    test("blocks findings outside the right-side diff", async ({
      magiFixture: { magi },
    }) => {
      const { config, review, updateEvent } = createReviewFixture(magi)
      const prompt = {
        create: vi.fn().mockResolvedValue("review-task"),
        parse: vi.fn().mockReturnValue({
          findings: [
            { body: "Invalid target.", line: 2, path: "src/missing.ts" },
          ],
          verdict: "CHANGES_REQUESTED",
        }),
        repair: vi.fn(),
        validate: vi.fn().mockReturnValue(true),
      }

      config.output.repairAttempts = 1
      config.review.reviewers = config.review.reviewers!.slice(0, 1)
      review.state.pr = {
        ...review.state.pr!,
        checks: createChecks(),
        inlineCommentTargets: { "base-sha": { "src/index.ts": [1, 2] } },
        metadata: createMetadata(),
        threads: [],
      }
      review.state.reviewers = {
        one: { sessionId: "reviewer-one-session", status: "initial" },
      }
      review.state.worktree = { path: "/tmp/worktree" }
      vi.spyOn(Prompt, "init").mockResolvedValue(prompt as unknown as Prompt)
      vi.spyOn(magi, "promptSession").mockResolvedValue("invalid-review")

      await expect(review.review()).rejects.toThrow(
        "Invalid output for reviewer one.",
      )
      expect(updateEvent).toHaveBeenCalledWith(
        review.state.output,
        "Attempt 1 failed to review with reviewer one. Retrying...",
      )
    })

    test("blocks follow-ups targeting another reviewer's thread", async ({
      magiFixture: { magi },
    }) => {
      const { config, review } = createReviewFixture(magi)
      const prompt = {
        create: vi.fn().mockResolvedValue("review-task"),
        parse: vi.fn().mockReturnValue({
          followUps: [{ body: "Invalid thread.", commentId: 999 }],
          verdict: "APPROVED",
        }),
        repair: vi.fn(),
        validate: vi.fn().mockReturnValue(true),
      }

      config.mode = "multi"
      config.output.repairAttempts = 1
      config.review.reviewers = config.review.reviewers!.slice(0, 1)
      review.state.pr = {
        ...review.state.pr!,
        checks: createChecks(),
        metadata: createMetadata(),
        threads: [],
      }
      review.state.reviewers = {
        one: { sessionId: "reviewer-one-session", status: "initial" },
      }
      review.state.worktree = { path: "/tmp/worktree" }
      vi.spyOn(Prompt, "init").mockResolvedValue(prompt as unknown as Prompt)
      vi.spyOn(magi, "promptSession").mockResolvedValue("invalid-review")

      await expect(review.review()).rejects.toThrow(
        "Invalid output for reviewer one.",
      )
    })

    test("blocks a mismatched thread resolution", async ({
      magiFixture: { magi },
    }) => {
      const { config, review } = createReviewFixture(magi)
      const prompt = {
        create: vi.fn().mockResolvedValue("review-task"),
        parse: vi.fn().mockReturnValue({
          resolves: [{ commentId: 101, threadId: "wrong-thread" }],
          verdict: "APPROVED",
        }),
        repair: vi.fn(),
        validate: vi.fn().mockReturnValue(true),
      }

      config.mode = "multi"
      config.output.repairAttempts = 1
      config.review.reviewers = config.review.reviewers!.slice(0, 1)
      review.state.pr = {
        ...review.state.pr!,
        checks: createChecks(),
        metadata: createMetadata(),
        threads: [
          {
            comments: [{ author: { login: "reviewer-one" }, databaseId: 101 }],
            id: "thread-1",
            isResolved: false,
          } as PullRequestReviewThread,
        ],
      }
      review.state.reviewers = {
        one: { sessionId: "reviewer-one-session", status: "initial" },
      }
      review.state.worktree = { path: "/tmp/worktree" }
      vi.spyOn(Prompt, "init").mockResolvedValue(prompt as unknown as Prompt)
      vi.spyOn(magi, "promptSession").mockResolvedValue("invalid-review")

      await expect(review.review()).rejects.toThrow(
        "Invalid output for reviewer one.",
      )
    })

    describe.each([
      ["a non-positive line", { line: 0 }],
      ["a non-positive start line", { line: 1, startLine: 0 }],
      ["a reversed line range", { line: 1, startLine: 2 }],
      ["a line outside a diff hunk", { line: 3 }],
    ])("blocks %s", (_label, target) => {
      test("rejects the semantic finding target", async ({
        magiFixture: { magi },
      }) => {
        const { config, review } = createReviewFixture(magi)
        const prompt = {
          create: vi.fn().mockResolvedValue("review-task"),
          parse: vi.fn().mockReturnValue({
            findings: [
              {
                body: "Invalid.",
                path: "src/index.ts",
                ...target,
              },
            ],
            verdict: "CHANGES_REQUESTED",
          }),
          repair: vi.fn(),
          validate: vi.fn().mockReturnValue(true),
        }

        config.output.repairAttempts = 1
        config.review.reviewers = config.review.reviewers!.slice(0, 1)
        review.state.pr = {
          ...review.state.pr!,
          checks: createChecks(),
          inlineCommentTargets: {
            "base-sha": { "src/index.ts": [1, 2] },
          },
          metadata: createMetadata(),
          threads: [],
        }
        review.state.reviewers = {
          one: { sessionId: "reviewer-one-session", status: "initial" },
        }
        review.state.worktree = { path: "/tmp/worktree" }
        vi.spyOn(Prompt, "init").mockResolvedValue(prompt as unknown as Prompt)
        vi.spyOn(magi, "promptSession").mockResolvedValue("invalid-review")

        await expect(review.review()).rejects.toThrow(
          "Invalid output for reviewer one.",
        )
      })
    })

    test("blocks a resolution targeting the wrong thread", async ({
      magiFixture: { magi },
    }) => {
      const { config, review } = createReviewFixture(magi)
      const prompt = {
        create: vi.fn().mockResolvedValue("review-task"),
        parse: vi.fn().mockReturnValue({
          resolves: [{ commentId: 101, threadId: "wrong-thread" }],
          verdict: "APPROVED",
        }),
        repair: vi.fn(),
        validate: vi.fn().mockReturnValue(true),
      }

      config.mode = "multi"
      config.output.repairAttempts = 1
      config.review.reviewers = config.review.reviewers!.slice(0, 1)
      review.state.pr = {
        ...review.state.pr!,
        checks: createChecks(),
        metadata: createMetadata(),
        threads: [
          {
            comments: [{ author: { login: "reviewer-one" }, databaseId: 101 }],
            id: "thread-1",
            isResolved: false,
          } as PullRequestReviewThread,
        ],
      }
      review.state.reviewers = {
        one: { sessionId: "reviewer-one-session", status: "initial" },
      }
      review.state.worktree = { path: "/tmp/worktree" }
      vi.spyOn(Prompt, "init").mockResolvedValue(prompt as unknown as Prompt)
      vi.spyOn(magi, "promptSession").mockResolvedValue("invalid-review")

      await expect(review.review()).rejects.toThrow(
        "Invalid output for reviewer one.",
      )
    })
  })

  describe("validateFindings", () => {
    test("skips validation when reviewers have no findings", async ({
      magiFixture: { magi },
    }) => {
      const { review, updateEvent, updateState } = createReviewFixture(magi)

      review.state.reviewers = {
        one: { outputs: [{ verdict: "APPROVED" }] },
      }

      await review.validateFindings()

      expect(updateEvent).not.toHaveBeenCalled()
      expect(updateState).not.toHaveBeenCalled()
    })

    test("accepts findings with majority support and discards the rest", async ({
      magiFixture: { magi },
    }) => {
      const { review, updateEvent } = createReviewFixture(magi)
      const prompt = {
        create: vi.fn().mockResolvedValue("validation-task"),
        parse: vi.fn((raw: string) => ({
          votes:
            raw === "reviewer-one-session"
              ? []
              : [
                  {
                    comment: `${raw} accepts the first finding`,
                    index: 0,
                    reviewer: "one",
                    vote: raw === "reviewer-two-session" ? "AGREE" : "DISAGREE",
                  },
                  {
                    comment: `${raw} rejects the second finding`,
                    index: 1,
                    reviewer: "one",
                    vote: "DISAGREE",
                  },
                ],
        })),
        repair: vi.fn(),
        validate: vi.fn().mockReturnValue(true),
      }

      review.state.reviewers = {
        one: {
          outputs: [
            {
              findings: [
                {
                  body: "First.",
                  line: 1,
                  path: "src/index.ts",
                  state: "accepted",
                },
                {
                  body: "Second.",
                  line: 2,
                  path: "src/index.ts",
                  state: "accepted",
                },
              ],
              verdict: "CHANGES_REQUESTED",
            },
          ],
          sessionId: "reviewer-one-session",
        },
        three: {
          outputs: [{ verdict: "APPROVED" }],
          sessionId: "reviewer-three-session",
        },
        two: {
          outputs: [{ verdict: "APPROVED" }],
          sessionId: "reviewer-two-session",
        },
      }
      vi.spyOn(Prompt, "init").mockResolvedValue(prompt as unknown as Prompt)
      vi.spyOn(magi, "promptSession").mockImplementation((sessionId) =>
        Promise.resolve(sessionId),
      )

      await review.validateFindings()

      expect(review.state.reviewers.one?.outputs?.[0]?.findings).toStrictEqual([
        expect.objectContaining({ body: "First.", state: "accepted" }),
        expect.objectContaining({ body: "Second.", state: "discarded" }),
      ])
      expect(updateEvent).toHaveBeenCalledWith(
        review.state.output,
        expect.stringContaining(
          "Finding one #1 was accepted by majority vote.",
        ),
      )
      expect(updateEvent).toHaveBeenCalledWith(
        review.state.output,
        expect.stringContaining(
          "Finding one #2 was rejected by majority vote.",
        ),
      )
    })

    test("requires a session from every configured reviewer", async ({
      magiFixture: { magi },
    }) => {
      const { review } = createReviewFixture(magi)

      review.state.reviewers = {
        one: {
          outputs: [
            {
              findings: [
                {
                  body: "Finding.",
                  line: 1,
                  path: "src/index.ts",
                  state: "accepted",
                },
              ],
              verdict: "CHANGES_REQUESTED",
            },
          ],
        },
        three: {},
        two: {},
      }

      await expect(review.validateFindings()).rejects.toThrow(
        "No session ID found for reviewer one.",
      )
    })

    describe.each([
      ["schema-invalid output", "schema"],
      ["a self vote", "self"],
      ["an unexpected vote", "unexpected"],
      ["a duplicate vote", "duplicate"],
      ["a missing vote", "missing"],
    ])("blocks %s", (_label, failure) => {
      test("rejects the invalid finding ballot", async ({
        magiFixture: { magi },
      }) => {
        const { config, review, updateEvent } = createReviewFixture(magi)
        const validVote = {
          comment: "Vote.",
          index: 0,
          reviewer: "one",
          vote: "AGREE",
        }
        const votes =
          failure === "self"
            ? [{ ...validVote, reviewer: "two" }]
            : failure === "unexpected"
              ? [{ ...validVote, index: 9 }]
              : failure === "duplicate"
                ? [validVote, validVote]
                : failure === "missing"
                  ? []
                  : [validVote]
        const prompt = {
          create: vi.fn().mockResolvedValue("validation-task"),
          parse: vi.fn((raw: string) => ({
            votes: raw === "reviewer-one-session" ? [] : votes,
          })),
          repair: vi.fn(),
          validate: vi.fn().mockReturnValue(failure !== "schema"),
        }

        config.output.repairAttempts = 1
        config.review.reviewers = config.review.reviewers!.slice(0, 2)
        review.state.reviewers = {
          one: {
            outputs: [
              {
                findings: [
                  {
                    body: "Finding.",
                    line: 1,
                    path: "src/index.ts",
                    state: "accepted",
                  },
                ],
                verdict: "CHANGES_REQUESTED",
              },
            ],
            sessionId: "reviewer-one-session",
          },
          two: {
            outputs: [{ verdict: "APPROVED" }],
            sessionId: "reviewer-two-session",
          },
        }
        vi.spyOn(Prompt, "init").mockResolvedValue(prompt as unknown as Prompt)
        vi.spyOn(magi, "promptSession").mockImplementation((sessionId) =>
          Promise.resolve(sessionId),
        )

        await expect(review.validateFindings()).rejects.toThrow(
          `Invalid finding validation output for reviewer ${failure === "schema" ? "one" : "two"}.`,
        )
        expect(updateEvent).toHaveBeenCalledWith(
          review.state.output,
          `Attempt 1 failed to validate review findings with reviewer ${failure === "schema" ? "one" : "two"}. Retrying...`,
        )
      })
    })
  })

  describe("reconsiderClose", () => {
    test("skips reconsideration under the majority policy", async ({
      magiFixture: { magi },
    }) => {
      const { review, updateEvent, updateState } = createReviewFixture(magi)

      await review.reconsiderClose()

      expect(updateEvent).not.toHaveBeenCalled()
      expect(updateState).not.toHaveBeenCalled()
    })

    describe.each([
      ["configured reviewers", "No reviewers configured."],
      ["reviewer state", "Reviewers not found."],
    ])("requires %s", (target, message) => {
      test("rejects incomplete state", async ({ magiFixture: { magi } }) => {
        const { config, review } = createReviewFixture(magi)

        config.review.merge.approvalPolicy = "unanimous"

        if (target === "configured reviewers") config.review.reviewers = []
        if (target !== "reviewer state") review.state.reviewers = {}

        await expect(review.reconsiderClose()).rejects.toThrow(message)
      })
    })

    describe.each([
      ["pull request metadata", "metadata", "PR metadata not found."],
      ["reviewer session", "session", "No session ID found for reviewer one."],
      [
        "previous review commit",
        "commit",
        "Missing previous review commit for reviewer one.",
      ],
    ])("requires %s", (_label, target, message) => {
      test("rejects incomplete reconsideration state", async ({
        magiFixture: { magi },
      }) => {
        const { config, review } = createReviewFixture(magi)
        const prompt = { create: vi.fn().mockResolvedValue("reconsider-task") }

        config.review.merge.approvalPolicy = "unanimous"
        review.state.pr!.metadata =
          target === "metadata" ? undefined : createMetadata()
        review.state.reviewers = {
          one: {
            outputs: [{ comment: "Close.", verdict: "CLOSED" }],
            review: (target === "commit"
              ? {}
              : { commit_id: "head-sha" }) as PullRequestReview,
            sessionId:
              target === "session" ? undefined : "reviewer-one-session",
            status: target === "commit" ? "rereview" : "initial",
          },
          three: { outputs: [{ verdict: "APPROVED" }] },
          two: { outputs: [{ verdict: "APPROVED" }] },
        }
        vi.spyOn(Prompt, "init").mockResolvedValue(prompt as unknown as Prompt)

        await expect(review.reconsiderClose()).rejects.toThrow(message)
      })
    })

    test("blocks after invalid reconsideration output exhausts retries", async ({
      magiFixture: { magi },
    }) => {
      const { config, review, updateEvent } = createReviewFixture(magi)
      const prompt = {
        create: vi.fn().mockResolvedValue("reconsider-task"),
        parse: vi.fn().mockReturnValue({}),
        repair: vi.fn(),
        validate: vi.fn().mockReturnValue(false),
      }

      config.output.repairAttempts = 1
      config.review.merge.approvalPolicy = "unanimous"
      review.state.pr!.metadata = createMetadata()
      review.state.reviewers = {
        one: {
          outputs: [{ comment: "Close.", verdict: "CLOSED" }],
          sessionId: "reviewer-one-session",
          status: "initial",
        },
        three: { outputs: [{ verdict: "APPROVED" }] },
        two: { outputs: [{ verdict: "APPROVED" }] },
      }
      vi.spyOn(Prompt, "init").mockResolvedValue(prompt as unknown as Prompt)
      vi.spyOn(magi, "promptSession").mockResolvedValue("invalid-output")

      await expect(review.reconsiderClose()).rejects.toThrow(
        "Invalid close reconsideration output for reviewer one.",
      )
      expect(updateEvent).toHaveBeenCalledWith(
        review.state.output,
        "Attempt 1 failed to reconsider close verdict with reviewer one. Retrying...",
      )
    })
  })

  describe("postReviews", () => {
    test("skips posting during a dry run", async ({
      magiFixture: { magi },
    }) => {
      const { octokitMocks, review, updateEvent } = createReviewFixture(magi)

      review.state.dryRun = true

      await review.postReviews()

      expect(octokitMocks.createReview).not.toHaveBeenCalled()
      expect(updateEvent).not.toHaveBeenCalled()
    })

    describe.each([
      ["configured reviewers", "No reviewers configured."],
      ["reviewer state", "Reviewers not found."],
      ["pull request verdict", "PR verdict not found."],
    ])("requires %s", (target, message) => {
      test("blocks incomplete posting state", async ({
        magiFixture: { magi },
      }) => {
        const { config, review } = createReviewFixture(magi)

        if (target === "configured reviewers") config.review.reviewers = []
        if (target !== "reviewer state") review.state.reviewers = {}
        if (target !== "pull request verdict")
          review.state.pr!.verdict = "APPROVED"

        await expect(review.postReviews()).rejects.toThrow(message)
      })
    })

    test("posts one marked review with thread actions in single mode", async ({
      magiFixture: { magi },
    }) => {
      const { graphql, graphqlMocks, octokit, octokitMocks, review } =
        createReviewFixture(magi)

      review.state.pr!.verdict = "APPROVED"
      review.state.reviewers = {
        one: {
          outputs: [
            {
              followUps: [{ body: "Please confirm.", commentId: 101 }],
              resolves: [{ commentId: 101, threadId: "thread-1" }],
              verdict: "APPROVED",
            },
          ],
          status: "initial",
        },
      }

      vi.spyOn(magi, "createOctokit").mockResolvedValue(octokit)
      vi.spyOn(magi, "createGraphql").mockReturnValue(graphql)
      graphqlMocks.resolveReviewThread.mockResolvedValue({})
      octokitMocks.createReplyForReviewComment.mockResolvedValue({})
      octokitMocks.createReview.mockResolvedValue({
        data: { html_url: "https://github.com/review/1" },
      })

      await review.postReviews()

      expect(graphqlMocks.resolveReviewThread).toHaveBeenCalledWith({
        threadId: "thread-1",
      })
      expect(octokitMocks.createReplyForReviewComment).toHaveBeenCalledWith(
        expect.objectContaining({ body: "Please confirm.", comment_id: 101 }),
      )
      expect(octokitMocks.createReview).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining("reviewer=one verdict=APPROVED"),
          event: "APPROVE",
        }),
      )
      expect(review.state.reviewers.one?.posted).toBe(
        "https://github.com/review/1",
      )
    })

    test("posts accepted findings with the reviewer account in multi mode", async ({
      magiFixture: { magi },
    }) => {
      const { config, octokit, octokitMocks, review } =
        createReviewFixture(magi)

      config.mode = "multi"
      review.state.reviewers = {
        one: {
          account: "reviewer-one",
          outputs: [
            {
              comment: "Changes are required.",
              findings: [
                {
                  body: "Fix this range.",
                  line: 3,
                  path: "src/index.ts",
                  startLine: 2,
                  state: "accepted",
                },
              ],
              verdict: "CHANGES_REQUESTED",
            },
          ],
        },
      }

      const createOctokit = vi
        .spyOn(magi, "createOctokit")
        .mockResolvedValue(octokit)

      octokitMocks.createReview.mockResolvedValue({
        data: { html_url: "https://github.com/review/2" },
      })

      await review.postReviews()

      expect(createOctokit).toHaveBeenCalledWith(
        config,
        review.context.abort,
        "reviewer-one",
      )
      expect(octokitMocks.createReview).toHaveBeenCalledWith(
        expect.objectContaining({
          comments: [
            expect.objectContaining({
              line: 3,
              start_line: 2,
              start_side: "RIGHT",
            }),
          ],
          event: "REQUEST_CHANGES",
        }),
      )
    })

    test("does not post a changes-requested review without accepted findings", async ({
      magiFixture: { magi },
    }) => {
      const { graphql, octokit, octokitMocks, review, updateEvent } =
        createReviewFixture(magi)

      review.state.pr!.verdict = "CHANGES_REQUESTED"
      review.state.reviewers = {
        one: {
          outputs: [
            {
              findings: [
                {
                  body: "Discarded.",
                  line: 1,
                  path: "src/index.ts",
                  state: "discarded",
                },
              ],
              verdict: "CHANGES_REQUESTED",
            },
          ],
        },
      }
      vi.spyOn(magi, "createOctokit").mockResolvedValue(octokit)
      vi.spyOn(magi, "createGraphql").mockReturnValue(graphql)

      await review.postReviews()

      expect(octokitMocks.createReview).not.toHaveBeenCalled()
      expect(updateEvent).toHaveBeenCalledWith(
        review.state.output,
        "Finished posting reviews.",
      )
    })

    test("requires an operator session to report a closed verdict", async ({
      magiFixture: { magi },
    }) => {
      const { graphql, octokit, review } = createReviewFixture(magi)

      review.state.pr!.verdict = "CLOSED"
      review.state.reviewers = {
        one: { outputs: [{ comment: "Close.", verdict: "CLOSED" }] },
      }
      vi.spyOn(magi, "createOctokit").mockResolvedValue(octokit)
      vi.spyOn(magi, "createGraphql").mockReturnValue(graphql)

      await expect(review.postReviews()).rejects.toThrow(
        "Reporter session ID not found.",
      )
    })

    test("blocks after invalid operator output exhausts retries", async ({
      magiFixture: { magi },
    }) => {
      const { config, graphql, octokit, review, updateEvent } =
        createReviewFixture(magi)
      const prompt = {
        create: vi.fn().mockResolvedValue("comment-task"),
        parse: vi.fn().mockReturnValue({}),
        repair: vi.fn(),
        validate: vi.fn().mockReturnValue(false),
      }

      config.output.repairAttempts = 1
      review.state.operator = { sessionId: "operator-session" }
      review.state.pr!.verdict = "CLOSED"
      review.state.reviewers = {
        one: { outputs: [{ comment: "Close.", verdict: "CLOSED" }] },
      }
      vi.spyOn(magi, "createOctokit").mockResolvedValue(octokit)
      vi.spyOn(magi, "createGraphql").mockReturnValue(graphql)
      vi.spyOn(Prompt, "init").mockResolvedValue(prompt as unknown as Prompt)
      vi.spyOn(magi, "promptSession").mockResolvedValue("invalid-output")

      await expect(review.postReviews()).rejects.toThrow(
        "Invalid output for operator.",
      )
      expect(updateEvent).toHaveBeenCalledWith(
        review.state.output,
        "Attempt 1 failed to post comment by operator. Retrying...",
      )
    })

    test("skips an existing review and posts multi-mode thread actions", async ({
      magiFixture: { magi },
    }) => {
      const { config, graphql, graphqlMocks, octokit, octokitMocks, review } =
        createReviewFixture(magi)

      config.mode = "multi"
      review.state.reviewers = {
        one: {
          account: "reviewer-one",
          outputs: [
            {
              followUps: [{ body: "Follow up.", commentId: 101 }],
              resolves: [{ commentId: 101, threadId: "thread-1" }],
              verdict: "APPROVED",
            },
          ],
        },
        two: {
          review: {
            html_url: "https://github.com/review/existing",
          } as PullRequestReview,
          status: "skip",
        },
      }
      octokitMocks.createReview.mockResolvedValue({
        data: { html_url: "https://github.com/review/new" },
      })
      vi.spyOn(magi, "createOctokit").mockResolvedValue(octokit)
      vi.spyOn(magi, "createGraphql").mockReturnValue(graphql)

      await review.postReviews()

      expect(graphqlMocks.resolveReviewThread).toHaveBeenCalledWith({
        threadId: "thread-1",
      })
      expect(octokitMocks.createReplyForReviewComment).toHaveBeenCalledWith(
        expect.objectContaining({ body: "Follow up.", comment_id: 101 }),
      )
      expect(review.state.reviewers.two?.posted).toBe(
        "https://github.com/review/existing",
      )
    })

    test("requires output from an active multi-mode reviewer", async ({
      magiFixture: { magi },
    }) => {
      const { config, review } = createReviewFixture(magi)

      config.mode = "multi"
      review.state.reviewers = { one: { account: "reviewer-one" } }

      await expect(review.postReviews()).rejects.toThrow(
        "Reviewer output not found.",
      )
    })
  })

  describe("automate", () => {
    test("skips automation for a changes-requested verdict", async ({
      magiFixture: { magi },
    }) => {
      const { exec, review, updateState } = createReviewFixture(magi)

      review.state.pr!.metadata = createMetadata()
      review.state.pr!.verdict = "CHANGES_REQUESTED"

      await expect(review.automate()).resolves.toBe("SKIPPED")
      expect(exec).not.toHaveBeenCalled()
      expect(updateState).not.toHaveBeenCalled()
    })

    describe.each([
      ["metadata", "PR metadata not found."],
      ["verdict", "PR verdict not found."],
      ["checks", "PR checks not found."],
    ])("requires pull request %s", (target, message) => {
      test("rejects incomplete state", async ({ magiFixture: { magi } }) => {
        const { review } = createReviewFixture(magi)

        review.state.operator = { account: "review-bot" }
        review.state.pr = {
          ...review.state.pr!,
          checks: target === "checks" ? undefined : createChecks(),
          metadata: target === "metadata" ? undefined : createMetadata(),
          verdict: target === "verdict" ? undefined : "APPROVED",
        }

        await expect(review.automate()).rejects.toThrow(message)
      })
    })

    test("skips approved automation while checks remain unresolved", async ({
      magiFixture: { magi },
    }) => {
      const { exec, review } = createReviewFixture(magi)

      review.state.operator = { account: "review-bot" }
      review.state.pr = {
        ...review.state.pr!,
        checks: {
          excluded: [],
          failed: [],
          passed: [],
          pending: [
            {
              bucket: "pending",
              id: "job-1",
              link: "https://github.com/actions/runs/1/job/1",
              name: "test",
              state: "PENDING",
              workflow: "CI",
            },
          ],
        },
        metadata: createMetadata(),
        verdict: "APPROVED",
      }

      await expect(review.automate()).resolves.toBe("SKIPPED")
      expect(review.state.pr.automation).toBe("SKIPPED")
      expect(exec).not.toHaveBeenCalled()
    })

    test("detects a merge conflict before starting automation", async ({
      magiFixture: { magi },
    }) => {
      const { exec, review } = createReviewFixture(magi)

      review.state.operator = { account: "review-bot" }
      review.state.pr = {
        ...review.state.pr!,
        checks: createChecks(),
        metadata: createMetadata(),
        verdict: "APPROVED",
      }
      review.state.worktree = { path: "/tmp/worktree" }
      exec.mockImplementation((command) => {
        if (command.includes("git merge --no-commit"))
          return Promise.reject(new Error("merge failed"))
        if (command.includes("git diff --name-only"))
          return Promise.resolve("src/index.ts")

        return Promise.resolve("")
      })

      await expect(review.automate()).resolves.toBe("CONFLICT")
      expect(review.state.pr.automation).toBe("CONFLICT")
      expect(exec).toHaveBeenCalledWith(
        "git merge --abort",
        expect.objectContaining({ cwd: "/tmp/worktree" }),
      )
    })

    test("blocks direct merge when branch rules require a merge queue", async ({
      magiFixture: { magi },
    }) => {
      const { exec, review } = createReviewFixture(magi)

      review.state.operator = { account: "review-bot" }
      review.state.pr = {
        ...review.state.pr!,
        checks: createChecks(),
        metadata: createMetadata(),
        verdict: "APPROVED",
      }
      vi.spyOn(magi, "getGhToken").mockResolvedValue("token")
      exec.mockResolvedValue(JSON.stringify([{ type: "merge_queue" }]))

      await expect(review.automate()).rejects.toThrow(
        "Base branch `main` requires merge queue",
      )
    })

    test("blocks auto-merge after a required check failure", async ({
      magiFixture: { magi },
    }) => {
      const { exec, review } = createReviewFixture(magi)

      review.state.operator = { account: "review-bot" }
      review.state.pr = {
        ...review.state.pr!,
        checks: createChecks(),
        metadata: createMetadata(),
        verdict: "APPROVED",
      }
      vi.spyOn(magi, "getGhToken").mockResolvedValue("token")
      exec.mockImplementation((command) => {
        if (command.includes("gh api")) return Promise.resolve("[]")
        if (command.includes("gh pr view"))
          return Promise.resolve(
            JSON.stringify({
              autoMergeRequest: {},
              mergeStateStatus: "BLOCKED",
              state: "OPEN",
              statusCheckRollup: [
                {
                  completedAt: "2026-07-23T01:00:00.000Z",
                  conclusion: "FAILURE",
                  name: "test",
                  workflowName: "CI",
                },
              ],
            }),
          )

        return Promise.resolve("")
      })

      await expect(review.automate()).rejects.toThrow(
        "Required checks failed before merging.",
      )
    })

    test("skips enabled automation during a dry run", async ({
      magiFixture: { magi },
    }) => {
      const { review, updateEvent } = createReviewFixture(magi)

      review.state.dryRun = true
      review.state.operator = { account: "review-bot" }
      review.state.pr = {
        ...review.state.pr!,
        checks: createChecks(),
        metadata: createMetadata(),
        verdict: "APPROVED",
      }

      await expect(review.automate()).resolves.toBe("SKIPPED")
      expect(updateEvent).toHaveBeenCalledWith(
        review.state.output,
        "Skipped merge automation during dry run.",
      )
    })

    test("reports a conflict discovered while waiting for auto-merge", async ({
      magiFixture: { magi },
    }) => {
      const { exec, review } = createReviewFixture(magi)

      review.state.operator = { account: "review-bot" }
      review.state.pr = {
        ...review.state.pr!,
        checks: createChecks(),
        metadata: createMetadata(),
        verdict: "APPROVED",
      }
      vi.spyOn(magi, "getGhToken").mockResolvedValue("token")
      exec.mockImplementation((command) => {
        if (command.includes("gh api")) return Promise.resolve("[]")
        if (command.includes("gh pr view"))
          return Promise.resolve(
            JSON.stringify({
              autoMergeRequest: {},
              mergeStateStatus: "DIRTY",
              state: "OPEN",
              statusCheckRollup: [],
            }),
          )

        return Promise.resolve("")
      })

      await expect(review.automate()).resolves.toBe("CONFLICT")
      expect(review.state.pr.automation).toBe("CONFLICT")
    })

    test("updates a behind branch while waiting for auto-merge", async ({
      magiFixture: { magi },
    }) => {
      const { exec, review, updateEvent } = createReviewFixture(magi)

      let views = 0

      review.state.operator = { account: "review-bot" }
      review.state.pr = {
        ...review.state.pr!,
        checks: createChecks(),
        metadata: createMetadata(),
        verdict: "APPROVED",
      }
      vi.spyOn(magi, "getGhToken").mockResolvedValue("token")
      exec.mockImplementation((command) => {
        if (command.includes("gh api")) return Promise.resolve("[]")

        if (command.includes("gh pr view")) {
          views += 1

          return Promise.resolve(
            JSON.stringify({
              autoMergeRequest: {},
              mergeStateStatus: views === 1 ? "BEHIND" : "CLEAN",
              state: views === 1 ? "OPEN" : "MERGED",
              statusCheckRollup: [],
            }),
          )
        }

        return Promise.resolve("")
      })
      vi.useFakeTimers()

      try {
        const result = review.automate()

        await vi.advanceTimersByTimeAsync(30_000)
        await expect(result).resolves.toBe("MERGED")
      } finally {
        vi.useRealTimers()
      }

      expect(exec).toHaveBeenCalledWith(
        expect.stringContaining("gh pr update-branch"),
        expect.any(Object),
      )
      expect(updateEvent).toHaveBeenCalledWith(
        review.state.output,
        "Updating with the base branch before merging.",
      )
    })

    test("updates an out-of-date branch and retries direct auto-merge", async ({
      magiFixture: { magi },
    }) => {
      const { exec, review, updateEvent } = createReviewFixture(magi)

      let mergeAttempts = 0

      review.state.operator = { account: "review-bot" }
      review.state.pr = {
        ...review.state.pr!,
        checks: createChecks(),
        metadata: createMetadata(),
        verdict: "APPROVED",
      }
      vi.spyOn(magi, "getGhToken").mockResolvedValue("token")
      exec.mockImplementation((command) => {
        if (command.includes("gh api")) return Promise.resolve("[]")

        if (command.includes("gh pr merge")) {
          mergeAttempts += 1

          if (mergeAttempts === 1)
            return Promise.reject(new Error("head branch is not up to date"))
        }

        if (command.includes("gh pr view"))
          return Promise.resolve(
            JSON.stringify({
              autoMergeRequest: {},
              mergeStateStatus: "CLEAN",
              state: "MERGED",
              statusCheckRollup: [],
            }),
          )

        return Promise.resolve("")
      })

      await expect(review.automate()).resolves.toBe("MERGED")
      expect(mergeAttempts).toBe(2)
      expect(exec).toHaveBeenCalledWith(
        expect.stringContaining("gh pr update-branch"),
        expect.any(Object),
      )
      expect(updateEvent).toHaveBeenCalledWith(
        review.state.output,
        "Updating with the base branch before merging.",
      )
    })

    test("re-enqueues after failed merge-queue checks", async ({
      magiFixture: { magi },
    }) => {
      const { config, graphqlMocks, review, updateEvent } =
        createReviewFixture(magi)
      const enqueuePullRequest = vi
        .fn()
        .mockRejectedValue(new Error("Pull request is already in the queue"))
      const mergeQueueStatus = vi
        .fn()
        .mockResolvedValueOnce({
          repository: {
            pullRequest: {
              isInMergeQueue: true,
              mergeQueueEntry: { id: "entry-1" },
              state: "OPEN",
              timelineItems: { nodes: [] },
            },
          },
        })
        .mockResolvedValueOnce({
          repository: {
            pullRequest: {
              isInMergeQueue: false,
              mergeQueueEntry: null,
              state: "OPEN",
              timelineItems: { nodes: [] },
            },
          },
        })
        .mockResolvedValueOnce({
          repository: {
            pullRequest: {
              isInMergeQueue: false,
              mergeQueueEntry: null,
              state: "OPEN",
              timelineItems: {
                nodes: [
                  {
                    createdAt: "2026-07-23T01:00:00.000Z",
                    reason: "failed_checks",
                  },
                ],
              },
            },
          },
        })
        .mockResolvedValueOnce({
          repository: {
            pullRequest: {
              isInMergeQueue: false,
              mergeQueueEntry: null,
              state: "MERGED",
              timelineItems: { nodes: [] },
            },
          },
        })

      config.review.merge.queue = true
      review.state.operator = { account: "review-bot" }
      review.state.pr = {
        ...review.state.pr!,
        checks: createChecks(),
        metadata: createMetadata(),
        verdict: "APPROVED",
      }
      Object.assign(graphqlMocks, { enqueuePullRequest, mergeQueueStatus })
      vi.spyOn(magi, "createGraphql").mockReturnValue(review.graphql)
      vi.spyOn(magi, "getGhToken").mockResolvedValue("token")
      vi.useFakeTimers()
      vi.setSystemTime("2026-07-23T00:00:00.000Z")

      try {
        const result = review.automate()

        await vi.advanceTimersByTimeAsync(30_000)
        await vi.advanceTimersByTimeAsync(30_000)
        await expect(result).resolves.toBe("MERGED")
      } finally {
        vi.useRealTimers()
      }

      expect(enqueuePullRequest).toHaveBeenCalledTimes(2)
      expect(updateEvent).toHaveBeenCalledWith(
        review.state.output,
        "Attempt 1 failed to merge from the merge queue. Retrying...",
      )
    })

    describe.each([
      ["merge", "--merge"],
      ["rebase", "--rebase"],
    ])("uses the %s merge method", (method, flag) => {
      test("passes the selected method to GitHub CLI", async ({
        magiFixture: { magi },
      }) => {
        const { config, exec, review } = createReviewFixture(magi)

        config.review.merge.auto = false
        config.review.merge.deleteBranch = false
        config.review.merge.method = method as "merge" | "rebase"
        review.state.operator = { account: "review-bot" }
        review.state.pr = {
          ...review.state.pr!,
          checks: createChecks(),
          metadata: createMetadata(),
          verdict: "APPROVED",
        }
        vi.spyOn(magi, "getGhToken").mockResolvedValue("token")
        exec.mockImplementation((command) =>
          Promise.resolve(command.includes("gh api") ? "[]" : ""),
        )

        await expect(review.automate()).resolves.toBe("MERGED")
        expect(exec).toHaveBeenCalledWith(
          expect.stringContaining(flag),
          expect.any(Object),
        )
      })
    })

    test("blocks when auto-merge is no longer enabled", async ({
      magiFixture: { magi },
    }) => {
      const { exec, review } = createReviewFixture(magi)

      review.state.operator = { account: "review-bot" }
      review.state.pr = {
        ...review.state.pr!,
        checks: createChecks(),
        metadata: createMetadata(),
        verdict: "APPROVED",
      }
      vi.spyOn(magi, "getGhToken").mockResolvedValue("token")
      exec.mockImplementation((command) => {
        if (command.includes("gh api")) return Promise.resolve("[]")
        if (command.includes("gh pr view"))
          return Promise.resolve(
            JSON.stringify({
              autoMergeRequest: null,
              mergeStateStatus: "CLEAN",
              state: "OPEN",
              statusCheckRollup: [],
            }),
          )

        return Promise.resolve("")
      })

      await expect(review.automate()).rejects.toThrow(
        "Auto-merge is no longer enabled.",
      )
    })

    test("reports a conflict returned by the merge command", async ({
      magiFixture: { magi },
    }) => {
      const { exec, review } = createReviewFixture(magi)

      review.state.operator = { account: "review-bot" }
      review.state.pr = {
        ...review.state.pr!,
        checks: createChecks(),
        metadata: createMetadata(),
        verdict: "APPROVED",
      }
      vi.spyOn(magi, "getGhToken").mockResolvedValue("token")
      exec.mockImplementation((command) => {
        if (command.includes("gh api")) return Promise.resolve("[]")
        if (command.includes("gh pr merge"))
          return Promise.reject(
            new Error("merge commit cannot be cleanly created"),
          )

        return Promise.resolve("")
      })

      await expect(review.automate()).resolves.toBe("CONFLICT")
      expect(review.state.pr.automation).toBe("CONFLICT")
    })

    test("blocks a dirty worktree before merge automation", async ({
      magiFixture: { magi },
    }) => {
      const { exec, review } = createReviewFixture(magi)

      review.state.operator = { account: "review-bot" }
      review.state.pr = {
        ...review.state.pr!,
        checks: createChecks(),
        metadata: createMetadata(),
        verdict: "APPROVED",
      }
      review.state.worktree = { path: "/tmp/worktree" }
      exec.mockResolvedValue(" M src/index.ts")

      await expect(review.automate()).rejects.toThrow(
        "PR worktree has uncommitted changes.",
      )
    })
  })

  describe("createReport", () => {
    test("writes a completed report and updates the review status", async ({
      magiFixture: { magi },
      temporaryDirectory,
    }) => {
      const { getEvents, review, updateState } = createReviewFixture(magi)
      const events = [
        { createdAt: "2026-07-23T00:00:00.000Z", message: "Finished." },
      ]

      review.state.output = temporaryDirectory
      getEvents.mockResolvedValue(events)
      vi.useFakeTimers()
      vi.setSystemTime("2026-07-23T02:00:00.000Z")

      let report: string

      try {
        report = await review.createReport()
      } finally {
        vi.useRealTimers()
      }

      expect(report).toContain("- **Status**: Completed")
      expect(report).toContain("- **Last action**: Finished.")
      await expect(
        readFile(join(temporaryDirectory, "report.md"), "utf8"),
      ).resolves.toBe(`${report}\n`)
      expect(updateState).toHaveBeenCalledWith(temporaryDirectory, {
        completedAt: "2026-07-23T02:00:00.000Z",
        status: "completed",
      })
    })
  })
})
