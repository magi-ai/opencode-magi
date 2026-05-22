import { afterEach, describe, expect, test } from "vitest"
import { mkdtemp, readFile, rm as removePath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  DuplicateIssueCandidate,
  IssueComment,
  IssueMeta,
  PullRequestCheck,
  PullRequestReview,
  RelatedPullRequest,
  ReviewThread,
} from "../github/commands"
import type { Exec, ResolvedRepository } from "../types"
import type { ApprovalPolicy } from "./majority"
import type { ModelClient } from "./model"
import { runMerge } from "./merge"
import { runReview } from "./review"
import { runTriage } from "./triage"

const reviewers = [
  {
    account: "bot-a",
    index: 0,
    key: "alpha",
    model: "mock/model",
    permission: "deny",
  },
  {
    account: "bot-b",
    index: 1,
    key: "beta",
    model: "mock/model",
    permission: "deny",
  },
  {
    account: "bot-c",
    index: 2,
    key: "gamma",
    model: "mock/model",
    permission: "deny",
  },
] satisfies ResolvedRepository["agents"]["reviewers"]

const repository: ResolvedRepository = {
  agents: {
    editor: {
      account: "editor-bot",
      author: { email: "editor@example.com", name: "Editor Bot" },
      model: "mock/model",
      permission: "deny",
    },
    reviewers,
  },
  alias: "repo",
  automation: { close: true, merge: true },
  checks: {
    exclude: [],
    retryFailedJobs: 3,
    waitAfterEdit: false,
    waitBeforeReview: false,
  },
  concurrency: { runs: 3, reviewers: 3 },
  github: {
    apiRetryAttempts: 3,
    host: "github.com",
    owner: "owner",
    repo: "repo",
  },
  merge: {
    approvalPolicy: "majority",
    auto: true,
    deleteBranch: true,
    maxThreadResolutionCycles: 2,
    mergeQueue: false,
    method: "squash",
  },
  prompts: {},
  safety: { allowAuthors: [], blockedPaths: [], requiredLabels: [] },
}

const temporaryDirs: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirs.map((dir) =>
      removePath(dir, { force: true, recursive: true }),
    ),
  )
  temporaryDirs.length = 0
})

function pullRequest(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    author: { login: "author" },
    baseRefName: "main",
    baseRefOid: "base-sha",
    body: "Closes #10",
    changedFiles: 1,
    headRefName: "feature-branch",
    headRefOid: "head-sha",
    headRepository: { name: "repo" },
    headRepositoryOwner: { login: "owner" },
    isDraft: false,
    number: 7,
    state: "OPEN",
    title: "Fix scenario flow",
    url: "https://github.com/owner/repo/pull/7",
    ...overrides,
  })
}

function emptyCommentPage(): string {
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          comments: { nodes: [], totalCount: 0 },
        },
      },
    },
  })
}

function emptyIssueCommentPage(): string {
  return JSON.stringify({
    data: {
      repository: {
        issue: {
          comments: { nodes: [], totalCount: 0 },
        },
      },
    },
  })
}

function reviewThreadsResponse(threads: ReviewThread[]): string {
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: threads.map((thread) => ({
              comments: {
                nodes: thread.comments.map((comment) => ({
                  author: { login: comment.author },
                  body: comment.body,
                  createdAt: comment.createdAt,
                  databaseId: comment.commentId,
                  line: thread.line,
                  path: thread.path,
                })),
                pageInfo: { endCursor: null, hasNextPage: false },
                totalCount: thread.comments.length,
              },
              id: thread.threadId,
              isResolved: thread.isResolved ?? false,
            })),
            pageInfo: { endCursor: null, hasNextPage: false },
            totalCount: threads.length,
          },
        },
      },
    },
  })
}

function closingIssuesResponse(): string {
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          closingIssuesReferences: {
            nodes: [
              {
                author: { login: "author" },
                body: "Scenario issue",
                issueType: { name: "Task" },
                labels: { nodes: [{ name: "task" }] },
                number: 10,
                state: "OPEN",
                title: "Scenario issue",
                url: "https://github.com/owner/repo/issues/10",
              },
            ],
          },
        },
      },
    },
  })
}

function safetyMetaResponse(input: { labels?: string[] } = {}): string {
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          author: { login: "author" },
          changedFiles: 1,
          files: {
            nodes: [{ path: "src/app.ts" }],
            pageInfo: { hasNextPage: false },
          },
          labels: { nodes: (input.labels ?? []).map((name) => ({ name })) },
        },
      },
    },
  })
}

function issueResponse(): string {
  return JSON.stringify({
    data: {
      repository: {
        issue: {
          author: { login: "author" },
          body: "Scenario issue",
          issueType: { name: "Task" },
          labels: { nodes: [{ name: "task" }] },
          number: 10,
          state: "OPEN",
          title: "Scenario issue",
          url: "https://github.com/owner/repo/issues/10",
        },
      },
    },
  })
}

function triageIssue(overrides: Partial<IssueMeta> = {}): IssueMeta {
  return {
    author: "author",
    body: "Issue body",
    labels: ["triage"],
    number: 1,
    state: "OPEN",
    title: "Issue title",
    url: "https://github.com/owner/repo/issues/1",
    ...overrides,
  }
}

function triageIssueResponse(value: IssueMeta): string {
  return JSON.stringify({
    data: {
      repository: {
        issue: {
          author: { login: value.author },
          body: value.body,
          issueType: value.type ? { name: value.type } : null,
          labels: { nodes: value.labels.map((name) => ({ name })) },
          number: value.number,
          state: value.state,
          title: value.title,
          url: value.url,
        },
      },
    },
  })
}

function triageCommentsResponse(values: IssueComment[]): string {
  return JSON.stringify({
    data: {
      repository: {
        issue: {
          comments: {
            nodes: values.map((value) => ({
              author: { login: value.author },
              authorAssociation: value.authorAssociation,
              body: value.body,
              createdAt: value.createdAt,
              databaseId: value.id,
              url: value.url,
            })),
          },
        },
      },
    },
  })
}

function relatedPullRequestsResponse(values: RelatedPullRequest[]): string {
  return JSON.stringify({
    data: {
      repository: {
        issue: {
          timelineItems: {
            nodes: values.map((value) => ({
              __typename: "CrossReferencedEvent",
              source: {
                __typename: "PullRequest",
                author: { login: value.author },
                body: value.body,
                mergedAt: value.mergedAt,
                number: value.number,
                state: value.state,
                title: value.title,
                url: value.url,
              },
            })),
          },
        },
      },
    },
  })
}

function reviewsResponse(reviews: PullRequestReview[]): string {
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          reviews: {
            nodes: reviews,
            pageInfo: { endCursor: null, hasNextPage: false },
          },
        },
      },
    },
  })
}

function review(overrides: Partial<PullRequestReview>): PullRequestReview {
  return {
    author: { login: "bot-a" },
    body: "previous review",
    commit: { oid: "old-sha" },
    state: "APPROVED",
    submittedAt: "2025-01-01T00:00:00Z",
    ...overrides,
  }
}

function commitsResponse(): string {
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          commits: {
            nodes: [
              {
                commit: {
                  committedDate: "2026-01-01T00:00:00Z",
                  oid: "head-sha",
                  parents: { totalCount: 1 },
                },
              },
            ],
            pageInfo: { endCursor: null, hasNextPage: false },
          },
        },
      },
    },
  })
}

function createExec(
  input: {
    checks?: PullRequestCheck[]
    duplicateCandidates?: DuplicateIssueCandidate[]
    issueComments?: IssueComment[]
    labels?: string[]
    relatedPullRequests?: RelatedPullRequest[]
    reviews?: PullRequestReview[]
    triageIssue?: IssueMeta
    threads?: ReviewThread[]
  } = {},
): { commands: string[]; exec: Exec } {
  const commands: string[] = []
  let checksRead = 0

  const exec: Exec = async (command) => {
    commands.push(command)

    if (command.startsWith("gh pr view 7")) return pullRequest()
    if (command.startsWith("gh auth token")) return "token\n"
    if (command.startsWith("gh pr review 7")) return "review posted"
    if (
      command.includes("repos/owner/repo/pulls/7/reviews") &&
      command.includes("--method POST")
    ) {
      return "https://github.com/owner/repo/pull/7#pullrequestreview-1"
    }
    if (command.startsWith("gh pr close 7")) return "closed"
    if (command.startsWith("gh pr merge 7")) return "merged"
    if (command.startsWith("gh pr checks 7") && command.includes("--watch")) {
      return ""
    }
    if (command.startsWith("gh pr checks 7") && command.includes("--json")) {
      checksRead += 1
      return JSON.stringify(checksRead === 1 ? (input.checks ?? []) : [])
    }
    if (command.startsWith("gh run view")) return "Error: stale test failure"
    if (command.startsWith("gh run rerun")) return ""
    if (command.startsWith("gh run watch")) return ""
    if (command.includes("actions/runs/123")) {
      return JSON.stringify({ head_sha: "head-sha", status: "completed" })
    }
    if (command.startsWith("git config --worktree")) return ""
    if (command.startsWith("git push")) return ""
    if (command.startsWith("git worktree add")) return ""
    if (command.startsWith("gh pr checkout 7")) return ""
    if (command === "git branch --show-current") return "feature-branch\n"
    if (command.startsWith("git worktree remove")) return ""
    if (command.startsWith("git worktree prune")) return ""
    if (command.startsWith("git cat-file -e")) return ""
    if (command.startsWith("git diff --no-ext-diff")) {
      return [
        "diff --git a/src/app.ts b/src/app.ts",
        "--- a/src/app.ts",
        "+++ b/src/app.ts",
        "@@ -1,1 +1,1 @@",
        "+export const value = 1",
      ].join("\n")
    }
    if (
      command.includes("repos/owner/repo/issues/1/comments") &&
      command.includes("--method POST")
    ) {
      return JSON.stringify({
        id: 9001,
        url: "https://github.com/owner/repo/issues/1#issuecomment-9001",
      })
    }
    if (
      command.includes("repos/owner/repo/issues/comments/") &&
      command.includes("--method PATCH")
    ) {
      return JSON.stringify({
        id: 9001,
        url: "https://github.com/owner/repo/issues/1#issuecomment-9001",
      })
    }
    if (command.startsWith("gh issue close 1")) return "closed"
    if (command.startsWith("gh issue edit 1")) return ""
    if (command.startsWith("gh pr create")) {
      return "https://github.com/owner/repo/pull/30"
    }
    if (command.startsWith("gh issue view 10")) {
      return JSON.stringify({
        body: "Original issue",
        createdAt: "2026-01-01T00:00:00Z",
        number: 10,
        state: "OPEN",
        title: "Original issue",
        url: "https://github.com/owner/repo/issues/10",
      })
    }
    if (command.startsWith("gh search issues")) {
      return JSON.stringify(input.duplicateCandidates ?? [])
    }
    if (command.startsWith("gh search prs")) return "[]"
    if (command.includes("repos/owner/repo/rules/branches/")) {
      return JSON.stringify([{ type: "merge_queue" }])
    }
    if (command.includes("enqueuePullRequest")) return "queue-entry-id"
    if (command.includes("isInMergeQueue")) {
      return JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              isInMergeQueue: false,
              mergeQueueEntry: null,
              state: "MERGED",
            },
          },
        },
      })
    }
    if (command.includes("pullRequest(number: $pr) { id headRefOid")) {
      return JSON.stringify({
        data: {
          repository: {
            pullRequest: { headRefOid: "head-sha", id: "pr-id" },
          },
        },
      })
    }
    if (command.includes("reviews(first: 100, after: $cursor)")) {
      return reviewsResponse(input.reviews ?? [])
    }
    if (command.includes("commits(first: 100, after: $cursor)")) {
      return commitsResponse()
    }
    if (command.includes("pullRequest(number: $pr) { comments")) {
      return emptyCommentPage()
    }
    if (command.includes("pullRequest(number: $pr) { reviewThreads")) {
      return reviewThreadsResponse(input.threads ?? [])
    }
    if (command.includes("pullRequest(number: $pr) { author")) {
      return safetyMetaResponse({ labels: input.labels })
    }
    if (command.includes("closingIssuesReferences")) {
      return closingIssuesResponse()
    }
    if (command.includes("comments(last:")) {
      return triageCommentsResponse(input.issueComments ?? [])
    }
    if (command.includes("timelineItems")) {
      return relatedPullRequestsResponse(input.relatedPullRequests ?? [])
    }
    if (command.includes("issue(number: $issue) { comments")) {
      return emptyIssueCommentPage()
    }
    if (command.includes("issueType")) {
      return triageIssueResponse(input.triageIssue ?? triageIssue())
    }
    if (command.includes("issue(number: $issue)")) return issueResponse()

    throw new Error(`Unexpected command: ${command}`)
  }

  return { commands, exec }
}

function createModelClient(outputs: string[]): {
  client: ModelClient
  prompts: string[]
  sessionTitles: string[]
} {
  const prompts: string[] = []
  const sessionTitles: string[] = []
  const client: ModelClient = {
    session: {
      async create(input) {
        sessionTitles.push(input.body.title)

        return { id: `session-${sessionTitles.length}` }
      },
      async prompt(input) {
        const parts = input.body.parts as { text?: string; type: string }[]
        const text = outputs.shift()

        prompts.push(parts.map((part) => part.text ?? "").join("\n"))
        if (text == null) throw new Error("Missing mocked model output")

        return { info: { text }, parts: [{ text, type: "text" }] }
      },
    },
  }

  return { client, prompts, sessionTitles }
}

async function runReviewScenario(input: {
  allowAlreadyReviewed?: boolean
  approvalPolicy?: ApprovalPolicy
  checks?: PullRequestCheck[]
  labels?: string[]
  outputs: string[]
  repository?: ResolvedRepository
  reviews?: PullRequestReview[]
  threads?: ReviewThread[]
}) {
  const directory = await mkdtemp(join(tmpdir(), "magi-review-scenario-"))
  temporaryDirs.push(directory)
  const model = createModelClient([...input.outputs])
  const exec = createExec({
    checks: input.checks,
    labels: input.labels,
    reviews: input.reviews,
    threads: input.threads,
  })
  const progress: unknown[] = []
  const result = await runReview({
    client: model.client,
    config: {},
    directory,
    dryRun: false,
    exec: exec.exec,
    onProgress: (item) => {
      progress.push(item)
    },
    allowAlreadyReviewed: input.allowAlreadyReviewed,
    approvalPolicy: input.approvalPolicy,
    pr: 7,
    repository: input.repository ?? repository,
    runId: "run-test",
  })

  return { ...exec, ...model, progress, result }
}

async function runMergeScenario(input: {
  checks?: PullRequestCheck[]
  dryRun?: boolean
  outputs: string[]
  repository?: ResolvedRepository
  reviews?: PullRequestReview[]
}) {
  const directory = await mkdtemp(join(tmpdir(), "magi-merge-scenario-"))
  temporaryDirs.push(directory)
  const model = createModelClient([...input.outputs])
  const exec = createExec({ checks: input.checks, reviews: input.reviews })
  const progress: unknown[] = []
  const result = await runMerge({
    client: model.client,
    config: {},
    directory,
    dryRun: input.dryRun ?? false,
    exec: exec.exec,
    onProgress: (item) => {
      progress.push(item)
    },
    pr: 7,
    repository: input.repository ?? repository,
    runId: "run-test",
  })

  return { ...exec, ...model, progress, result }
}

function reviewOutput(verdict: string): string {
  return JSON.stringify({ findings: [], verdict })
}

function closeOutput(): string {
  return JSON.stringify({
    findings: [],
    reason: "Not planned.",
    verdict: "CLOSE",
  })
}

function rereviewOutput(verdict: string): string {
  return JSON.stringify({
    followUps: [],
    newFindings: [],
    resolve: [],
    verdict,
  })
}

function editOutput(mode = "EDITED"): string {
  if (mode === "REPLIED") {
    return JSON.stringify({
      filesTouched: [],
      mode,
      responses: [{ action: "ASK", body: "Could not update.", commentId: -1 }],
    })
  }

  return JSON.stringify({
    commitMessage: "fix(orchestrator): address review feedback",
    commitSha: "edited-sha",
    filesTouched: ["src/app.ts"],
    mode,
    responses: [{ action: "FIXED", body: "Updated.", commentId: -1 }],
  })
}

function ciCheck(): PullRequestCheck {
  return {
    bucket: "fail",
    link: "https://github.com/owner/repo/actions/runs/123/job/456",
    name: "test",
    state: "FAILURE",
    workflow: "CI",
  }
}

function ciClassification(classification = "SCOPE_OUT"): string {
  return JSON.stringify({
    checks: [{ classification, name: "test", reason: "stale failure" }],
  })
}

function currentReview(
  account: string,
  state: "APPROVED" | "CHANGES_REQUESTED",
): PullRequestReview {
  return review({
    author: { login: account },
    body:
      state === "CHANGES_REQUESTED"
        ? "Inline findings:\n- src/app.ts:1: Value is wrong.\n  Fix: Update the value."
        : "Looks good.",
    commit: { oid: "head-sha" },
    state,
    submittedAt: "2026-01-02T00:00:00Z",
  })
}

function triageRepository(
  overrides: Partial<
    Omit<NonNullable<ResolvedRepository["triage"]>, "automation" | "safety">
  > & {
    automation?: Partial<
      NonNullable<ResolvedRepository["triage"]>["automation"]
    >
    safety?: Partial<NonNullable<ResolvedRepository["triage"]>["safety"]>
  } = {},
): ResolvedRepository {
  const { automation, safety, ...rest } = overrides
  const triage = {
    categories: [
      {
        description: "Something is broken or behaves incorrectly.",
        id: "bug",
        labels: ["bug"],
        types: ["Bug"],
      },
      {
        description: "Maintenance, refactoring, chores, or planned work.",
        id: "task",
        labels: ["task"],
        types: ["Task"],
      },
      {
        description: "New or improved user-facing capability.",
        id: "feature",
        labels: ["enhancement"],
        types: ["Feature"],
      },
    ],
    concurrency: { runs: 3 },
    prompts: {},
    ...rest,
    automation: {
      clear: ["triage"],
      close: false,
      create: false,
      merge: false,
      review: false,
      ...automation,
    },
    safety: {
      allowAuthors: [],
      allowMentionActors: [],
      allowMentionRoles: ["MEMBER"],
      blockedLabels: [],
      requiredLabels: ["triage"],
      ...safety,
    },
  } satisfies NonNullable<ResolvedRepository["triage"]>

  return {
    ...repository,
    agents: {
      ...repository.agents,
      triage: [
        {
          account: "melchior-bot",
          id: "Melchior",
          index: 0,
          key: "Melchior",
          model: "mock/model",
          permission: "deny",
        },
        {
          account: "balthasar-bot",
          id: "Balthasar",
          index: 1,
          key: "Balthasar",
          model: "mock/model",
          permission: "deny",
        },
        {
          account: "caspar-bot",
          id: "Caspar",
          index: 2,
          key: "Caspar",
          model: "mock/model",
          permission: "deny",
        },
      ],
    },
    triage,
  }
}

async function runTriageScenario(input: {
  comments?: IssueComment[]
  dryRun?: boolean
  duplicateCandidates?: DuplicateIssueCandidate[]
  issue?: IssueMeta
  outputs: string[]
  relatedPullRequests?: RelatedPullRequest[]
  repository?: ResolvedRepository
}) {
  const directory = await mkdtemp(join(tmpdir(), "magi-triage-scenario-"))
  temporaryDirs.push(directory)
  const model = createModelClient([...input.outputs])
  const exec = createExec({
    duplicateCandidates: input.duplicateCandidates,
    issueComments: input.comments,
    relatedPullRequests: input.relatedPullRequests,
    triageIssue: input.issue,
  })
  const progress: unknown[] = []
  const result = await runTriage({
    client: model.client,
    config: {},
    directory,
    dryRun: input.dryRun ?? true,
    exec: exec.exec,
    issue: 1,
    onProgress: (item) => {
      progress.push(item)
    },
    repository: input.repository ?? triageRepository(),
    runId: "run-test",
  })

  return { ...exec, ...model, progress, result }
}

function triageVote(vote: string): string {
  return JSON.stringify({
    body: vote === "ASK" ? `${vote} body` : undefined,
    reason: `${vote} reason`,
    vote,
  })
}

function duplicateVote(vote: string, duplicateOf?: number): string {
  return JSON.stringify({ duplicateOf, reason: `${vote} reason`, vote })
}

function comment(overrides: Partial<IssueComment>): IssueComment {
  return {
    author: "user",
    body: "body",
    createdAt: "2026-01-01T00:00:00Z",
    id: 1,
    url: "https://example.com/comment/1",
    ...overrides,
  }
}

describe("scenario: /magi:review", () => {
  test("posts deterministic approvals without live GitHub calls", async () => {
    const result = await runReviewScenario({
      outputs: [
        reviewOutput("MERGE"),
        reviewOutput("MERGE"),
        reviewOutput("MERGE"),
      ],
    })

    expect(result.result.verdict).toBe("MERGE")
    expect(result.result.posted).toEqual({
      alpha: "review posted",
      beta: "review posted",
      gamma: "review posted",
    })
    expect(result.sessionTitles).toHaveLength(3)
    expect(result.sessionTitles).toEqual(
      expect.arrayContaining([
        "magi review repo#7 alpha",
        "magi review repo#7 beta",
        "magi review repo#7 gamma",
      ]),
    )
    expect(
      result.commands.filter((command) => command.startsWith("gh pr review 7")),
    ).toHaveLength(3)
    expect(result.commands).not.toContain(
      "gh pr checks 7 --repo 'owner/repo' --watch",
    )
  })

  test("stops at the safety gate before reviewer sessions", async () => {
    const result = await runReviewScenario({
      labels: [],
      outputs: [],
      repository: {
        ...repository,
        safety: {
          ...repository.safety,
          requiredLabels: ["safe-to-review"],
        },
      },
    })

    expect(result.result.verdict).toBe("SAFETY_BLOCKED")
    expect(result.sessionTitles).toEqual([])
    expect(
      result.commands.some((command) => command.startsWith("gh pr review 7")),
    ).toBe(false)
  })

  test("reruns reviews after new commits", async () => {
    const result = await runReviewScenario({
      outputs: [
        rereviewOutput("MERGE"),
        rereviewOutput("MERGE"),
        rereviewOutput("MERGE"),
      ],
      reviews: [
        review({ author: { login: "bot-a" } }),
        review({ author: { login: "bot-b" } }),
        review({ author: { login: "bot-c" } }),
      ],
    })

    expect(result.result.verdict).toBe("MERGE")
    expect(result.sessionTitles).toEqual(
      expect.arrayContaining([
        "magi rereview repo#7 alpha",
        "magi rereview repo#7 beta",
        "magi rereview repo#7 gamma",
      ]),
    )
  })

  test("enforces majority and unanimous approval policies", async () => {
    const majority = await runReviewScenario({
      allowAlreadyReviewed: true,
      approvalPolicy: "majority",
      outputs: [],
      reviews: [
        currentReview("bot-a", "APPROVED"),
        currentReview("bot-b", "APPROVED"),
        currentReview("bot-c", "CHANGES_REQUESTED"),
      ],
    })
    const unanimous = await runReviewScenario({
      allowAlreadyReviewed: true,
      approvalPolicy: "unanimous",
      outputs: [],
      reviews: [
        currentReview("bot-a", "APPROVED"),
        currentReview("bot-b", "APPROVED"),
        currentReview("bot-c", "CHANGES_REQUESTED"),
      ],
    })

    expect(majority.result.verdict).toBe("MERGE")
    expect(unanimous.result.verdict).toBe("CHANGES_REQUESTED")
  })

  test("waits for CI and reruns scope-out failures before review", async () => {
    const result = await runReviewScenario({
      checks: [ciCheck()],
      outputs: [
        ciClassification(),
        ciClassification(),
        ciClassification(),
        reviewOutput("MERGE"),
        reviewOutput("MERGE"),
        reviewOutput("MERGE"),
      ],
      repository: {
        ...repository,
        checks: { ...repository.checks, waitBeforeReview: true },
      },
    })

    expect(result.result.verdict).toBe("MERGE")
    expect(
      result.commands.some((command) => command.startsWith("gh run rerun")),
    ).toBe(true)
    expect(
      result.commands.some((command) => command.startsWith("gh run watch")),
    ).toBe(true)
  })

  test("does not run merge automation when changes are requested", async () => {
    const result = await runReviewScenario({
      outputs: [closeOutput(), closeOutput(), reviewOutput("MERGE")],
      repository: {
        ...repository,
        reviewAutomation: { close: false, merge: true },
      },
    })

    expect(result.result.verdict).toBe("CLOSE")
    expect(
      result.commands.some((command) => command.startsWith("gh pr merge 7")),
    ).toBe(false)
  })
})

describe("scenario: /magi:merge", () => {
  test("merges an approved PR without a merge queue", async () => {
    const result = await runMergeScenario({
      outputs: [
        reviewOutput("MERGE"),
        reviewOutput("MERGE"),
        reviewOutput("MERGE"),
      ],
    })

    expect(result.result.status).toBe("merged")
    expect(
      result.commands.some((command) => command.startsWith("gh pr merge 7")),
    ).toBe(true)
    expect(
      result.commands.some((command) => command.includes("enqueuePullRequest")),
    ).toBe(false)
  })

  test("enqueues an approved PR when merge queue is required", async () => {
    const result = await runMergeScenario({
      outputs: [
        reviewOutput("MERGE"),
        reviewOutput("MERGE"),
        reviewOutput("MERGE"),
      ],
      repository: {
        ...repository,
        merge: { ...repository.merge, mergeQueue: true },
      },
    })

    expect(result.result.status).toBe("merged")
    expect(result.result.cycles).toBe(0)
    expect(
      result.commands.some((command) =>
        command.includes("repos/owner/repo/rules/branches/"),
      ),
    ).toBe(true)
    expect(
      result.commands.some((command) => command.includes("enqueuePullRequest")),
    ).toBe(true)
    expect(
      result.commands.some((command) => command.includes("isInMergeQueue")),
    ).toBe(true)
  })

  test("closes a PR when reviewers request closure", async () => {
    const result = await runMergeScenario({
      outputs: [closeOutput(), closeOutput(), closeOutput()],
      repository: {
        ...repository,
        automation: { ...repository.automation, close: true },
      },
    })

    expect(result.result.status).toBe("closed")
    expect(
      result.commands.some((command) => command.startsWith("gh pr close 7")),
    ).toBe(true)
  })

  test("edits and reruns review cycles until approval", async () => {
    const result = await runMergeScenario({
      dryRun: true,
      outputs: [
        editOutput(),
        rereviewOutput("MERGE"),
        rereviewOutput("MERGE"),
        rereviewOutput("MERGE"),
      ],
      reviews: [
        currentReview("bot-a", "CHANGES_REQUESTED"),
        currentReview("bot-b", "CHANGES_REQUESTED"),
        currentReview("bot-c", "APPROVED"),
      ],
    })

    expect(result.result.status).toBe("approved")
    expect(result.result.cycles).toBe(1)
    expect(result.sessionTitles).toEqual(
      expect.arrayContaining([
        "magi edit repo#7 cycle 1",
        "magi rereview repo#7 alpha cycle 1",
      ]),
    )
  })

  test("stops merging when CI remains scope-in after approval", async () => {
    const result = await runMergeScenario({
      checks: [ciCheck()],
      outputs: [
        ciClassification("SCOPE_IN"),
        ciClassification("SCOPE_IN"),
        ciClassification("SCOPE_IN"),
        reviewOutput("MERGE"),
        reviewOutput("MERGE"),
        reviewOutput("MERGE"),
      ],
    })

    expect(result.result.status).toBe("ci_unresolved")
    expect(
      result.commands.some((command) => command.startsWith("gh pr merge 7")),
    ).toBe(false)
  })

  test("reports thread-resolution limits during edit cycles", async () => {
    const result = await runMergeScenario({
      dryRun: true,
      outputs: [
        editOutput("REPLIED"),
        rereviewOutput("MERGE"),
        rereviewOutput("MERGE"),
        rereviewOutput("MERGE"),
      ],
      reviews: [
        currentReview("bot-a", "CHANGES_REQUESTED"),
        currentReview("bot-b", "CHANGES_REQUESTED"),
        currentReview("bot-c", "APPROVED"),
      ],
      repository: {
        ...repository,
        merge: { ...repository.merge, maxThreadResolutionCycles: 1 },
      },
    })

    expect(result.result.status).toBe("approved")
    expect(result.result.cycles).toBe(1)
    expect(
      result.progress.some((item) =>
        Boolean(
          item &&
          typeof item === "object" &&
          "type" in item &&
          item.type === "thread_limit_reached",
        ),
      ),
    ).toBe(true)
  })

  test("stops at the safety gate before review and merge actions", async () => {
    const result = await runMergeScenario({
      outputs: [],
      repository: {
        ...repository,
        safety: {
          ...repository.safety,
          requiredLabels: ["safe-to-merge"],
        },
      },
    })

    expect(result.result.status).toBe("safety_blocked")
    expect(result.sessionTitles).toEqual([])
    expect(
      result.commands.some((command) => command.startsWith("gh pr merge 7")),
    ).toBe(false)
  })
})

describe("scenario: /magi:triage", () => {
  test("skips classification when issue type maps to a category", async () => {
    const result = await runTriageScenario({
      issue: triageIssue({ type: "Bug" }),
      outputs: [triageVote("YES"), triageVote("YES"), triageVote("YES")],
    })

    expect(result.result.result).toEqual({
      category: "bug",
      disposition: "accepted",
    })
    expect(
      result.sessionTitles.some((title) => title.includes("triage category")),
    ).toBe(false)
  })

  test("falls back to kind votes when category shortcuts are absent", async () => {
    const result = await runTriageScenario({
      issue: triageIssue({ labels: ["triage"], type: undefined }),
      outputs: [
        triageVote("feature"),
        triageVote("feature"),
        triageVote("ASK"),
        triageVote("YES"),
        triageVote("YES"),
        triageVote("YES"),
      ],
    })

    expect(result.result.result).toEqual({
      category: "feature",
      disposition: "accepted",
    })
    expect(
      result.sessionTitles.filter((title) => title.includes("triage category")),
    ).toHaveLength(3)
  })

  test("handles duplicate issues before category classification", async () => {
    const result = await runTriageScenario({
      issue: triageIssue({ body: "Duplicate of #10" }),
      outputs: [
        duplicateVote("DUPLICATE", 10),
        duplicateVote("DUPLICATE", 10),
        duplicateVote("NOT_DUPLICATE"),
      ],
    })

    expect(result.result.result).toEqual({
      category: null,
      disposition: "duplicate",
    })
    expect(
      result.sessionTitles.some((title) => title.includes("triage category")),
    ).toBe(false)
  })

  test("clears labels when an open related PR already handles the issue", async () => {
    const result = await runTriageScenario({
      outputs: [
        triageVote("RELATED_PR_HANDLES_ISSUE"),
        triageVote("RELATED_PR_HANDLES_ISSUE"),
        triageVote("RELATED_PR_DOES_NOT_HANDLE_ISSUE"),
      ],
      relatedPullRequests: [
        {
          author: "dev",
          body: "Fixes #1",
          number: 20,
          state: "OPEN",
          title: "Fix issue",
          url: "https://github.com/owner/repo/pull/20",
        },
      ],
    })

    expect(result.result.result).toEqual({
      category: null,
      disposition: "clear_only",
    })
    expect(
      result.sessionTitles.filter((title) =>
        title.includes("triage existing PR"),
      ),
    ).toHaveLength(3)
  })

  test("closes accepted issues when merged related PRs handle them", async () => {
    const result = await runTriageScenario({
      dryRun: false,
      outputs: [
        triageVote("RELATED_PR_HANDLES_ISSUE"),
        triageVote("RELATED_PR_HANDLES_ISSUE"),
        triageVote("RELATED_PR_DOES_NOT_HANDLE_ISSUE"),
      ],
      relatedPullRequests: [
        {
          author: "dev",
          body: "Fixes #1",
          mergedAt: "2026-01-02T00:00:00Z",
          number: 20,
          state: "MERGED",
          title: "Fix issue",
          url: "https://github.com/owner/repo/pull/20",
        },
      ],
      repository: triageRepository({ automation: { close: true } }),
    })

    expect(result.result.result).toEqual({
      category: null,
      disposition: "accepted",
    })
    expect(
      result.commands.some((command) => command.startsWith("gh issue close 1")),
    ).toBe(true)
  })

  test("reconsiders previous triage after eligible mention replies", async () => {
    const result = await runTriageScenario({
      comments: [
        comment({
          author: "melchior-bot",
          body: "Previous comment\n\n<!-- opencode-magi:triage v=1 issue=1 result=FEATURE_ACCEPTED action=COMMENT checkpoint=10 pr=none processed= -->",
          id: 10,
        }),
        comment({
          author: "maintainer",
          authorAssociation: "MEMBER",
          body: "@melchior-bot this should be reconsidered",
          id: 11,
        }),
      ],
      outputs: [
        JSON.stringify({
          comments: [
            { classification: "OBJECTION", commentId: 11, reason: "valid" },
          ],
        }),
        triageVote("NO"),
        triageVote("NO"),
        triageVote("ASK"),
      ],
    })

    const commentBody = await readFile(
      join(result.result.outputDir, "comment.md"),
      "utf8",
    )

    expect(result.result.result).toEqual({
      category: "feature",
      disposition: "rejected",
    })
    expect(commentBody).toContain("NO reason")
    expect(
      result.sessionTitles.some((title) => title.includes("triage reconsider")),
    ).toBe(true)
  })
})
