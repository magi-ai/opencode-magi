import { afterEach, describe, expect, test } from "vitest"
import { mkdtemp, rm as removePath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { PullRequestReview, ReviewThread } from "../github/commands"
import type { Exec, ResolvedRepository } from "../types"
import type { ModelClient } from "./model"
import { runMerge } from "./merge"
import { runReview } from "./review"

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
                totalCount: thread.comments.length,
              },
              id: thread.threadId,
              isResolved: thread.isResolved ?? false,
            })),
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

function reviewsResponse(reviews: PullRequestReview[]): string {
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: { reviews: { nodes: reviews } },
      },
    },
  })
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
          },
        },
      },
    },
  })
}

function createExec(
  input: {
    labels?: string[]
    reviews?: PullRequestReview[]
    threads?: ReviewThread[]
  } = {},
): { commands: string[]; exec: Exec } {
  const commands: string[] = []

  const exec: Exec = async (command) => {
    commands.push(command)

    if (command.startsWith("gh pr view 7")) return pullRequest()
    if (command.startsWith("gh auth token")) return "token\n"
    if (command.startsWith("gh pr review 7")) return "review posted"
    if (command.startsWith("gh pr merge 7")) return "merged"
    if (command.startsWith("gh pr checks 7") && command.includes("--json")) {
      return "[]"
    }
    if (command.startsWith("git worktree add")) return ""
    if (command.startsWith("gh pr checkout 7")) return ""
    if (command === "git branch --show-current") return "feature-branch\n"
    if (command.startsWith("git worktree remove")) return ""
    if (command.startsWith("git worktree prune")) return ""
    if (command.startsWith("git diff --no-ext-diff")) {
      return [
        "diff --git a/src/app.ts b/src/app.ts",
        "--- a/src/app.ts",
        "+++ b/src/app.ts",
        "@@ -1,1 +1,1 @@",
        "+export const value = 1",
      ].join("\n")
    }
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
    if (command.includes("reviews(first: 100)")) {
      return reviewsResponse(input.reviews ?? [])
    }
    if (command.includes("commits(first: 100)")) return commitsResponse()
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
    if (command.includes("issue(number: $issue) { comments")) {
      return emptyIssueCommentPage()
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
    pr: 7,
    repository: input.repository ?? repository,
    runId: "run-test",
  })

  return { ...exec, ...model, progress, result }
}

async function runMergeScenario(input: {
  outputs: string[]
  repository?: ResolvedRepository
}) {
  const directory = await mkdtemp(join(tmpdir(), "magi-merge-scenario-"))
  temporaryDirs.push(directory)
  const model = createModelClient([...input.outputs])
  const exec = createExec()
  const progress: unknown[] = []
  const result = await runMerge({
    client: model.client,
    config: {},
    directory,
    dryRun: false,
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
})

describe("scenario: /magi:merge", () => {
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
})
