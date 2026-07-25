import type { ToolContext } from "@opencode-ai/plugin"
import type { Octokit } from "octokit"
import type { Config } from "@/config"
import type { Graphql } from "@/graphql"
import type { Magi, State } from "@/magi"
import type { PullRequestMetadata } from "@/tools/review"
import type { Exec } from "@/utils"
import { DEFAULT_CONFIG } from "@/constant"
import { Review } from "@/tools/review/review"
import { merge } from "@/utils"

export interface OctokitMocks {
  createReplyForReviewComment: ReturnType<typeof vi.fn>
  createReview: ReturnType<typeof vi.fn>
  get: ReturnType<typeof vi.fn>
  listComments: ReturnType<typeof vi.fn>
  listCommits: ReturnType<typeof vi.fn>
  listFiles: ReturnType<typeof vi.fn>
  listReviews: ReturnType<typeof vi.fn>
  paginate: ReturnType<typeof vi.fn>
}

export interface GraphqlMocks {
  closingIssues: ReturnType<typeof vi.fn>
  enqueuePullRequest: ReturnType<typeof vi.fn>
  mergeQueueStatus: ReturnType<typeof vi.fn>
  paginate: ReturnType<typeof vi.fn>
  resolveReviewThread: ReturnType<typeof vi.fn>
  reviewThreads: ReturnType<typeof vi.fn>
}

interface ReviewConstructor<T extends Review> {
  new (...args: ConstructorParameters<typeof Review>): T
}

export interface ReviewFixture<T extends Review> {
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
  review: T
  state: State
  updateEvent: ReturnType<typeof vi.fn<Magi["updateEvent"]>>
  updateState: ReturnType<typeof vi.fn<Magi["updateState"]>>
}

export function createMetadata(): PullRequestMetadata {
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
      repo: {
        clone_url: "https://github.com/octocat/opencode-magi.git",
        name: "opencode-magi",
        owner: { login: "octocat" },
      },
      sha: "head-sha",
    },
    labels: [],
    node_id: "pr-node",
    state: "open",
    user: { login: "octocat" },
  } as unknown as PullRequestMetadata
}

export function createConfig(): Config.Root {
  const config = structuredClone(DEFAULT_CONFIG)

  config.account = "review-bot"
  config.github.owner = "magi-ai"
  config.github.repo = "opencode-magi"
  config.github.url = "https://github.com/magi-ai/opencode-magi"
  config.merge.editor = {
    account: "editor",
    author: { email: "editor@example.com", name: "Editor" },
    model: "editor-model",
    permissions: "allow",
  }
  config.review.reviewers = [
    { account: "reviewer-one", id: "one", model: "model-one" },
    { account: "reviewer-two", id: "two", model: "model-two" },
    { account: "reviewer-three", id: "three", model: "model-three" },
  ]

  return config
}

export function createState(overrides: Partial<State> = {}): State {
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

export function createReviewFixture(magi: Magi): ReviewFixture<Review>
export function createReviewFixture<T extends Review>(
  magi: Magi,
  Subject: ReviewConstructor<T>,
  stateOverrides?: Partial<State>,
): ReviewFixture<T>
export function createReviewFixture<T extends Review>(
  magi: Magi,
  Subject: ReviewConstructor<T> = Review as unknown as ReviewConstructor<T>,
  stateOverrides: Partial<State> = {},
): ReviewFixture<T> {
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
    enqueuePullRequest: vi.fn(),
    mergeQueueStatus: vi.fn(),
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
  const state = createState(stateOverrides)

  magi.exec = exec

  const updateState = vi
    .spyOn(magi, "updateState")
    .mockImplementation(async (_output, next) => merge(state, next))
  const updateEvent = vi.spyOn(magi, "updateEvent").mockResolvedValue()
  const getEvents = vi.spyOn(magi, "getEvents").mockResolvedValue([])
  const createAgentFile = vi.spyOn(magi, "createAgentFile").mockResolvedValue()
  const review = new Subject(
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
