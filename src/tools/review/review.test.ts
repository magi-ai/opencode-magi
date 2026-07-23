import type { ToolContext } from "@opencode-ai/plugin"
import type { Octokit } from "octokit"
import type { PullRequestChecks, PullRequestMetadata } from "."
import type { Config } from "@/config"
import type { Graphql } from "@/graphql"
import type { Magi, State } from "@/magi"
import type { Exec } from "@/utils"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { test } from "#/fixtures/magi"
import { DEFAULT_CONFIG } from "@/constant"
import { merge } from "@/utils"
import { Review } from "./review"

interface OctokitMocks {
  createReplyForReviewComment: ReturnType<typeof vi.fn>
  createReview: ReturnType<typeof vi.fn>
  get: ReturnType<typeof vi.fn>
  listComments: ReturnType<typeof vi.fn>
  listCommits: ReturnType<typeof vi.fn>
  listFiles: ReturnType<typeof vi.fn>
  listReviews: ReturnType<typeof vi.fn>
  paginate: ReturnType<typeof vi.fn>
}

interface GraphqlMocks {
  closingIssues: ReturnType<typeof vi.fn>
  paginate: ReturnType<typeof vi.fn>
  resolveReviewThread: ReturnType<typeof vi.fn>
  reviewThreads: ReturnType<typeof vi.fn>
}

interface ReviewFixture {
  config: Config.Root
  context: ToolContext
  controller: AbortController
  createAgentFile: ReturnType<typeof vi.fn<Magi["createAgentFile"]>>
  exec: ReturnType<typeof vi.fn<Exec>>
  getEvents: ReturnType<typeof vi.fn<Magi["getEvents"]>>
  graphql: Graphql
  graphqlMocks: GraphqlMocks
  octokit: Octokit
  octokitMocks: OctokitMocks
  review: Review
  state: State
  updateEvent: ReturnType<typeof vi.fn<Magi["updateEvent"]>>
  updateState: ReturnType<typeof vi.fn<Magi["updateState"]>>
}

function createMetadata(): PullRequestMetadata {
  return {
    base: {
      ref: "main",
      repo: { clone_url: "https://github.com/magi-ai/opencode-magi.git" },
      sha: "base-sha",
    },
    changed_files: 1,
    draft: false,
    head: {
      ref: "feature",
      repo: { clone_url: "https://github.com/octocat/opencode-magi.git" },
      sha: "head-sha",
    },
    labels: [],
    node_id: "pr-node",
    state: "open",
    user: { login: "octocat" },
  } as unknown as PullRequestMetadata
}

function createConfig(): Config.Root {
  const config = structuredClone(DEFAULT_CONFIG)

  config.account = "review-bot"
  config.github.owner = "magi-ai"
  config.github.repo = "opencode-magi"
  config.github.url = "https://github.com/magi-ai/opencode-magi"
  config.review.reviewers = [
    { account: "reviewer-one", id: "one", model: "model-one" },
    { account: "reviewer-two", id: "two", model: "model-two" },
    { account: "reviewer-three", id: "three", model: "model-three" },
  ]

  return config
}

function createState(overrides: Partial<State> = {}): State {
  return {
    command: "review",
    createdAt: "2026-07-23T00:00:00.000Z",
    dryRun: false,
    id: "run-1",
    output: "/tmp/review-run",
    pr: {
      number: 42,
      url: "https://github.com/magi-ai/opencode-magi/pull/42",
    },
    repo: "'magi-ai/opencode-magi'",
    sessionId: "parent-session",
    status: "preparing",
    updatedAt: "2026-07-23T00:00:00.000Z",
    ...overrides,
  }
}

function createReviewFixture(magi: Magi): ReviewFixture {
  const config = createConfig()
  const controller = new AbortController()
  const context = {
    abort: controller.signal,
    sessionID: "parent-session",
  } as ToolContext
  const exec = vi.fn<Exec>().mockResolvedValue("")
  const octokitMocks: OctokitMocks = {
    createReplyForReviewComment: vi.fn(),
    createReview: vi.fn(),
    get: vi.fn().mockResolvedValue({ data: createMetadata() }),
    listComments: vi.fn(),
    listCommits: vi.fn(),
    listFiles: vi.fn(),
    listReviews: vi.fn(),
    paginate: vi.fn().mockResolvedValue([]),
  }
  const octokit = {
    paginate: octokitMocks.paginate,
    rest: {
      issues: { listComments: octokitMocks.listComments },
      pulls: {
        createReplyForReviewComment: octokitMocks.createReplyForReviewComment,
        createReview: octokitMocks.createReview,
        get: octokitMocks.get,
        listCommits: octokitMocks.listCommits,
        listFiles: octokitMocks.listFiles,
        listReviews: octokitMocks.listReviews,
      },
    },
  } as unknown as Octokit
  const graphqlMocks: GraphqlMocks = {
    closingIssues: vi.fn(),
    paginate: vi.fn(),
    resolveReviewThread: vi.fn(),
    reviewThreads: vi.fn(),
  }

  graphqlMocks.paginate.mockImplementation((request) => {
    if (request === graphqlMocks.closingIssues)
      return Promise.resolve({
        repository: {
          pullRequest: { closingIssuesReferences: { nodes: [] } },
        },
      })

    return Promise.resolve({
      repository: { pullRequest: { reviewThreads: { nodes: [] } } },
    })
  })

  const graphql = graphqlMocks as unknown as Graphql
  const state = createState()

  magi.exec = exec

  const updateState = vi
    .spyOn(magi, "updateState")
    .mockImplementation(async (_output, next) => merge(state, next))
  const updateEvent = vi.spyOn(magi, "updateEvent").mockResolvedValue()
  const getEvents = vi.spyOn(magi, "getEvents").mockResolvedValue([])
  const createAgentFile = vi.spyOn(magi, "createAgentFile").mockResolvedValue()
  const review = new Review(
    42,
    magi,
    config,
    context,
    octokit,
    graphql,
    exec,
    state,
  )

  updateState.mockImplementation(async (_output, next) =>
    merge(review.state, next),
  )

  return {
    config,
    context,
    controller,
    createAgentFile,
    exec,
    getEvents,
    graphql,
    graphqlMocks,
    octokit,
    octokitMocks,
    review,
    state,
    updateEvent,
    updateState,
  }
}

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
