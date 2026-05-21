import type { Exec, ResolvedRepository } from "../types"
import { mkdtemp, readFile, rm as removePath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import {
  createWorktree,
  fetchIssue,
  fetchRelatedPullRequests,
  fetchPullRequest,
  fetchPullRequestChecks,
  fetchPullRequestComments,
  fetchPullRequestCommits,
  fetchPullRequestReviews,
  fetchPullRequestSafetyMeta,
  fetchUnresolvedThreads,
  ghHostOption,
  mergePullRequest,
  postChangesRequested,
  postCloseComment,
  pushHead,
  repoSpecifier,
  searchDuplicateIssues,
  shellQuote,
  waitForChecks,
  waitForMergeQueue,
} from "./commands"

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
    host: "github.com",
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

function extractGraphqlQuery(command: string): string {
  const match = command.match(/-f query='([^']+)'/)

  if (!match) throw new Error(`GraphQL query not found in command: ${command}`)

  return match[1]
}

function expectBalancedBraces(value: string): void {
  const opening = value.split("{").length - 1
  const closing = value.split("}").length - 1

  expect(opening).toBe(closing)
}

describe("GitHub command helpers", () => {
  test("shell-quotes values without allowing variable expansion", () => {
    expect(shellQuote("query($owner: String!) { viewer { login } }")).toBe(
      "'query($owner: String!) { viewer { login } }'",
    )
  })

  test("escapes single quotes for shell arguments", () => {
    expect(shellQuote("it's fine")).toBe("'it'\\''s fine'")
  })

  test("uses configured GitHub host for CLI commands", () => {
    const enterprise = {
      ...repository,
      github: { ...repository.github, host: "github.example.com" },
    }

    expect(repoSpecifier(repository)).toBe("owner/repo")
    expect(ghHostOption(repository)).toBe("")
    expect(repoSpecifier(enterprise)).toBe("github.example.com/owner/repo")
    expect(ghHostOption(enterprise)).toBe(" --hostname 'github.example.com'")
  })

  test("fetches issues through GraphQL with issue type", async () => {
    const commands: string[] = []

    const result = await fetchIssue(
      async (value) => {
        commands.push(value)

        return JSON.stringify({
          data: {
            repository: {
              issue: {
                author: { login: "author" },
                body: "Issue body",
                issueType: { name: "Bug" },
                labels: { nodes: [{ name: "triage" }] },
                number: 56,
                state: "OPEN",
                title: "Issue title",
                url: "https://github.com/owner/repo/issues/56",
              },
            },
          },
        })
      },
      repository,
      56,
    )

    expect(commands).toHaveLength(1)
    expect(commands[0]).toContain("gh api graphql")
    expect(commands[0]).toContain("issueType")
    expectBalancedBraces(extractGraphqlQuery(commands[0]))
    expect(result).toEqual({
      author: "author",
      body: "Issue body",
      labels: ["triage"],
      number: 56,
      state: "OPEN",
      title: "Issue title",
      type: "Bug",
      url: "https://github.com/owner/repo/issues/56",
    })
  })

  test("falls back to gh issue view without issue type when GraphQL is unavailable", async () => {
    const commands: string[] = []

    const result = await fetchIssue(
      async (value) => {
        commands.push(value)
        if (value.includes("graphql")) throw new Error("unsupported field")

        return JSON.stringify({
          author: { login: "author" },
          body: "Issue body",
          labels: [{ name: "triage" }],
          number: 56,
          state: "OPEN",
          title: "Issue title",
          url: "https://github.com/owner/repo/issues/56",
        })
      },
      repository,
      56,
    )

    expect(commands[0]).toContain("issueType")
    expect(commands[1]).toContain(
      "--json number,title,body,url,state,author,labels",
    )
    expect(result.type).toBeUndefined()
  })

  test("searches duplicate issue candidates by title and excludes the current issue", async () => {
    const commands: string[] = []
    const title =
      "Align docs/config.md triage.prompts entries with review and merge prompts"

    const result = await searchDuplicateIssues(
      async (command) => {
        commands.push(command)

        return JSON.stringify([
          {
            body: "same issue",
            number: 42,
            state: "OPEN",
            title: "Bug report",
            url: "https://github.com/owner/repo/issues/42",
          },
          {
            body: "related issue",
            number: 43,
            state: "OPEN",
            title: "Bug report",
            url: "https://github.com/owner/repo/issues/43",
          },
        ])
      },
      repository,
      {
        author: "author",
        body: "body",
        labels: [],
        number: 42,
        state: "OPEN",
        title,
        url: "https://github.com/owner/repo/issues/42",
      },
    )

    expect(commands).toEqual([
      "gh search issues --repo 'owner/repo' --json number,title,url,state,body --limit 5 -- 'Align docs/config.md triage.prompts entries with review and merge prompts'",
    ])
    expect(result.map((item) => item.number)).toEqual([43])
  })

  test("normalizes searched related pull request states", async () => {
    let graphqlCommand = ""

    const result = await fetchRelatedPullRequests(
      async (command) => {
        if (command.includes("graphql")) {
          graphqlCommand = command

          return JSON.stringify({
            data: {
              repository: {
                issue: { timelineItems: { nodes: [] } },
              },
            },
          })
        }

        expect(command).toContain("gh search prs")

        return JSON.stringify([
          {
            author: { login: "bot" },
            body: "Fixes #58",
            number: 10,
            state: "MERGED",
            title: "Fix issue",
            url: "https://github.com/owner/repo/pull/10",
          },
          {
            author: { login: "bot" },
            body: "Closes #58",
            number: 11,
            state: "closed",
            title: "Closed attempt",
            url: "https://github.com/owner/repo/pull/11",
          },
          {
            author: { login: "bot" },
            body: "Resolves #58",
            number: 12,
            state: "open",
            title: "Open attempt",
            url: "https://github.com/owner/repo/pull/12",
          },
        ])
      },
      repository,
      58,
    )

    expectBalancedBraces(extractGraphqlQuery(graphqlCommand))
    expect(result.map((pr) => [pr.number, pr.state])).toEqual([
      [10, "MERGED"],
      [11, "CLOSED"],
      [12, "OPEN"],
    ])
  })

  test("pushes detached HEAD to the PR head repository", async () => {
    const commands: string[] = []
    const options: Array<Parameters<Exec>[1]> = []

    await pushHead(
      async (command, option) => {
        commands.push(command)
        options.push(option)
        if (command.includes("gh auth token")) return "token"

        return ""
      },
      repository,
      "/tmp/worktree",
      "editor-bot",
      { owner: "fork-owner", ref: "feature-branch", repo: "fork-repo" },
    )

    expect(commands[1]).toContain(
      "push 'https://github.com/fork-owner/fork-repo.git' 'HEAD:refs/heads/feature-branch'",
    )
    expect(commands[1]).not.toContain("token")
    expect(options[1]?.env?.GIT_PASSWORD).toBe("token")
    expect(options[1]?.env?.GIT_CONFIG_VALUE_1).toContain("$GIT_PASSWORD")
  })

  test("passes GitHub token through exec env for merges", async () => {
    const commands: string[] = []
    const options: Array<Parameters<Exec>[1]> = []

    await mergePullRequest(
      async (command, option) => {
        commands.push(command)
        options.push(option)
        if (command.includes("gh auth token")) return "token"

        return ""
      },
      repository,
      7557,
      "bot-a",
    )

    expect(commands[1]).toContain("gh pr merge 7557")
    expect(commands[1]).not.toContain("GH_TOKEN")
    expect(commands[1]).not.toContain("token")
    expect(options[1]?.env?.GH_TOKEN).toBe("token")
  })

  test("merges pull requests with configured flags", async () => {
    const commands: string[] = []

    await mergePullRequest(
      async (command) => {
        commands.push(command)
        if (command.includes("gh auth token")) return "token"

        return ""
      },
      repository,
      7557,
      "bot-a",
    )

    expect(commands[1]).toContain("gh pr merge 7557")
    expect(commands[1]).toContain("--squash --auto --delete-branch")
  })

  test("queues pull requests through GraphQL in merge queue mode", async () => {
    const commands: string[] = []
    const options: Array<Parameters<Exec>[1]> = []

    const result = await mergePullRequest(
      async (command, option) => {
        commands.push(command)
        options.push(option)
        if (command.includes("gh auth token")) return "token"
        if (command.includes("pullRequest(number")) {
          return JSON.stringify({
            data: {
              repository: {
                pullRequest: { headRefOid: "head-sha", id: "PR_node_id" },
              },
            },
          })
        }
        if (command.includes("enqueuePullRequest")) return "queue-entry-id"

        throw new Error(`unexpected command: ${command}`)
      },
      { ...repository, merge: { ...repository.merge, mergeQueue: true } },
      7557,
      "bot-a",
    )

    expect(result).toBe("queue-entry-id")
    expect(commands).toHaveLength(3)
    expect(commands[1]).toContain("pullRequest(number: $pr)")
    expect(commands[2]).toContain("enqueuePullRequest")
    expect(commands[2]).toContain("pullRequestId='PR_node_id'")
    expect(commands[2]).toContain("expectedHeadOid='head-sha'")
    expect(options[1]?.env?.GH_TOKEN).toBe("token")
    expect(options[2]?.env?.GH_TOKEN).toBe("token")
  })

  test("waits for merge queue state through GraphQL", async () => {
    const commands: string[] = []
    const statuses = [
      { isInMergeQueue: true, mergeQueueEntry: { id: "entry" }, state: "OPEN" },
      { isInMergeQueue: false, mergeQueueEntry: null, state: "MERGED" },
    ]

    const result = await waitForMergeQueue(
      async (command) => {
        commands.push(command)

        return JSON.stringify({
          data: { repository: { pullRequest: statuses.shift() } },
        })
      },
      repository,
      7557,
      0,
    )

    expect(result).toBe("merged")
    expect(commands[0]).toContain("isInMergeQueue")
    expect(commands[0]).toContain("mergeQueueEntry")
  })

  test("returns dequeued when a pull request leaves the merge queue", async () => {
    const result = await waitForMergeQueue(
      async () =>
        JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                isInMergeQueue: false,
                mergeQueueEntry: null,
                state: "OPEN",
              },
            },
          },
        }),
      repository,
      7557,
      0,
    )

    expect(result).toBe("dequeued")
  })

  test("fetches PR head repository metadata", async () => {
    let command = ""
    const result = await fetchPullRequest(
      async (value) => {
        command = value

        return JSON.stringify({
          baseRefName: "main",
          baseRefOid: "base-sha",
          headRefName: "feature-branch",
          headRefOid: "head-sha",
          headRepository: { name: "fork-repo" },
          headRepositoryOwner: { login: "fork-owner" },
          isDraft: false,
          number: 1,
          title: "PR title",
          url: "https://github.com/owner/repo/pull/1",
        })
      },
      repository,
      1,
    )

    expect(command).toContain("headRepository,headRepositoryOwner")
    expect(result.headRepository?.name).toBe("fork-repo")
    expect(result.headRepositoryOwner?.login).toBe("fork-owner")
  })

  test("tolerates transient missing pull request checks when requested", async () => {
    const result = await fetchPullRequestChecks(
      async () => {
        throw Object.assign(new Error("Command failed"), {
          stderr: "no checks reported on the 'feature-branch' branch",
        })
      },
      repository,
      1,
      { tolerateMissingChecks: true },
    )

    expect(result).toEqual([])
  })

  test("keeps other pull request check failures fatal", async () => {
    await expect(
      fetchPullRequestChecks(
        async () => {
          throw new Error("gh pr checks failed")
        },
        repository,
        1,
        { tolerateMissingChecks: true },
      ),
    ).rejects.toThrow("gh pr checks failed")
  })

  test("posts close comments as PR review comments", async () => {
    const commands: string[] = []
    const options: Array<Parameters<Exec>[1]> = []
    let payload: unknown

    const result = await postCloseComment(
      async (command, option) => {
        commands.push(command)
        options.push(option)
        if (command.includes("gh auth token")) return "token"

        const input = command.match(/--input '([^']+)'/)?.[1]
        if (!input) throw new Error(`input path not found: ${command}`)
        payload = JSON.parse(await readFile(input, "utf8"))

        return "https://github.com/owner/repo/pull/7557#pullrequestreview-1"
      },
      repository,
      7557,
      "bot-a",
      "This PR should be closed.",
    )

    expect(result).toBe(
      "https://github.com/owner/repo/pull/7557#pullrequestreview-1",
    )
    expect(commands[1]).toContain("repos/owner/repo/pulls/7557/reviews")
    expect(commands[1]).not.toContain("repos/owner/repo/issues/7557/comments")
    expect(commands[1]).not.toContain("GH_TOKEN")
    expect(options[1]?.env?.GH_TOKEN).toBe("token")
    expect(payload).toEqual({
      body: "This PR should be closed.",
      event: "COMMENT",
    })
  })

  test("posts body-only findings in review body without inline comments", async () => {
    const commands: string[] = []
    let payload:
      | { body: string; comments: unknown[]; event: string }
      | undefined

    await postChangesRequested(
      async (command) => {
        commands.push(command)
        if (command.includes("gh auth token")) return "token"

        const input = command.match(/--input '([^']+)'/)?.[1]
        if (!input) throw new Error(`input path not found: ${command}`)
        payload = JSON.parse(await readFile(input, "utf8"))

        return "https://github.com/owner/repo/pull/7557#pullrequestreview-2"
      },
      repository,
      7557,
      "bot-a",
      [
        {
          fix: "Pass structured findings to the editor.",
          issue: "Body-only findings are lost.",
          path: "src/orchestrator/merge.ts",
        },
        {
          fix: "Validate only inline targets.",
          issue: "Inline validation rejects file-level findings.",
          line: 10,
          path: "src/orchestrator/review.ts",
        },
      ],
      [
        {
          evidence: "The runtime path is missing.",
          fix: "Include requirement findings in the editor prompt.",
          issueNumber: 121,
          requirement: "Body-only findings must reach the editor.",
        },
      ],
    )

    expect(payload?.event).toBe("REQUEST_CHANGES")
    expect(payload?.comments).toHaveLength(1)
    expect(payload?.body).toContain("Inline findings:")
    expect(payload?.body).toContain("src/orchestrator/review.ts:10")
    expect(payload?.body).toContain("File-level findings:")
    expect(payload?.body).toContain("src/orchestrator/merge.ts")
    expect(payload?.body).toContain("Requirement findings:")
    expect(commands[1]).toContain("repos/owner/repo/pulls/7557/reviews")
  })

  test("keeps GraphQL variables quoted in PR review query", async () => {
    let graphqlCommand = ""

    await fetchPullRequestReviews(
      async (command) => {
        graphqlCommand = command

        return JSON.stringify({
          data: {
            repository: {
              pullRequest: { reviews: { nodes: [] } },
            },
          },
        })
      },
      repository,
      7557,
    )

    expect(graphqlCommand).toContain(
      "-f query='query($owner: String!, $repo: String!, $pr: Int!)",
    )
    expect(graphqlCommand).toContain("-F owner='owner'")
    expect(graphqlCommand).toContain("-F repo='repo'")
    expectBalancedBraces(extractGraphqlQuery(graphqlCommand))
  })

  test("passes configured GitHub host to GraphQL requests", async () => {
    let graphqlCommand = ""
    const enterprise = {
      ...repository,
      github: { ...repository.github, host: "github.example.com" },
    }

    await fetchPullRequestReviews(
      async (command) => {
        graphqlCommand = command

        return JSON.stringify({
          data: {
            repository: {
              pullRequest: { reviews: { nodes: [] } },
            },
          },
        })
      },
      enterprise,
      7557,
    )

    expect(graphqlCommand).toContain(
      "gh api --hostname 'github.example.com' graphql",
    )
  })

  test("uses balanced GraphQL in PR commit query", async () => {
    let graphqlCommand = ""

    await fetchPullRequestCommits(
      async (command) => {
        graphqlCommand = command

        return JSON.stringify({
          data: {
            repository: {
              pullRequest: { commits: { nodes: [] } },
            },
          },
        })
      },
      repository,
      7557,
    )

    expectBalancedBraces(extractGraphqlQuery(graphqlCommand))
  })

  test("fetches pull request comments through pullRequest GraphQL", async () => {
    let graphqlCommand = ""
    const result = await fetchPullRequestComments(
      async (command) => {
        graphqlCommand = command

        return JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                comments: {
                  nodes: [
                    {
                      author: { login: "commenter" },
                      authorAssociation: "MEMBER",
                      body: "PR comment",
                      createdAt: "2026-01-01T00:00:00Z",
                      databaseId: 123,
                      url: "https://github.com/owner/repo/pull/1#issuecomment-123",
                    },
                  ],
                },
              },
            },
          },
        })
      },
      repository,
      7557,
      20,
    )

    expect(graphqlCommand).toContain("pullRequest(number: $pr)")
    expectBalancedBraces(extractGraphqlQuery(graphqlCommand))
    expect(result).toEqual([
      {
        author: "commenter",
        authorAssociation: "MEMBER",
        body: "PR comment",
        createdAt: "2026-01-01T00:00:00Z",
        id: 123,
        url: "https://github.com/owner/repo/pull/1#issuecomment-123",
      },
    ])
  })

  test("paginates PR files for safety metadata", async () => {
    const commands: string[] = []
    const result = await fetchPullRequestSafetyMeta(
      async (command) => {
        commands.push(command)

        return JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                author: { login: "author" },
                changedFiles: 2,
                files: {
                  nodes: command.includes("-F filesCursor")
                    ? [{ path: "src/b.ts" }]
                    : [{ path: "src/a.ts" }],
                  pageInfo: command.includes("-F filesCursor")
                    ? { endCursor: undefined, hasNextPage: false }
                    : { endCursor: "cursor", hasNextPage: true },
                },
                labels: { nodes: [{ name: "magi-ok" }] },
              },
            },
          },
        })
      },
      repository,
      7557,
    )

    expect(result).toEqual({
      author: "author",
      changedFiles: 2,
      files: ["src/a.ts", "src/b.ts"],
      labels: ["magi-ok"],
    })
    expect(commands).toHaveLength(2)
    expectBalancedBraces(extractGraphqlQuery(commands[0]))
    expect(commands[1]).toContain("-F filesCursor='cursor'")
  })

  test("keeps thread ids when fetching unresolved threads for editing", async () => {
    const threads = await fetchUnresolvedThreads(
      async () => {
        return JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [
                    {
                      comments: {
                        nodes: [
                          {
                            author: { login: "bot-a" },
                            body: "Fix this.",
                            createdAt: "2026-01-01T00:00:00Z",
                            databaseId: 123,
                            line: 10,
                            path: "src/app.ts",
                          },
                        ],
                      },
                      id: "thread-id",
                      isResolved: false,
                    },
                  ],
                },
              },
            },
          },
        })
      },
      repository,
      7557,
    )

    expect(threads).toEqual([
      {
        body: "Fix this.",
        commentId: 123,
        comments: [
          {
            author: "bot-a",
            body: "Fix this.",
            commentId: 123,
            createdAt: "2026-01-01T00:00:00Z",
          },
        ],
        line: 10,
        path: "src/app.ts",
        threadId: "thread-id",
      },
    ])
  })

  test("keeps full conversation when fetching reviewer unresolved threads", async () => {
    const threads = await fetchUnresolvedThreads(
      async () => {
        return JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [
                    {
                      comments: {
                        nodes: [
                          {
                            author: { login: "bot-a" },
                            body: "Fix this.",
                            createdAt: "2026-01-01T00:00:00Z",
                            databaseId: 123,
                            line: 10,
                            path: "src/app.ts",
                          },
                          {
                            author: { login: "author" },
                            body: "This is not needed because input is safe.",
                            createdAt: "2026-01-01T00:00:01Z",
                            databaseId: 124,
                            line: 10,
                            path: "src/app.ts",
                          },
                        ],
                      },
                      id: "thread-id",
                      isResolved: false,
                    },
                  ],
                },
              },
            },
          },
        })
      },
      repository,
      7557,
      "bot-a",
    )

    expect(threads).toEqual([
      {
        commentId: 123,
        comments: [
          {
            author: "bot-a",
            body: "Fix this.",
            commentId: 123,
            createdAt: "2026-01-01T00:00:00Z",
          },
          {
            author: "author",
            body: "This is not needed because input is safe.",
            commentId: 124,
            createdAt: "2026-01-01T00:00:01Z",
          },
        ],
        latestBody: "Fix this.",
        line: 10,
        path: "src/app.ts",
        threadId: "thread-id",
      },
    ])
  })
})

describe("createWorktree", () => {
  test("checks out pull requests without binding the head branch", async () => {
    const root = await mkdtemp(join(tmpdir(), "magi-worktrees-"))
    const commands: string[] = []

    try {
      const result = await createWorktree(
        async (command) => {
          commands.push(command)
          if (command === "git branch --show-current") return "\n"

          return ""
        },
        repository,
        1,
        root,
      )

      expect(result.branch).toBeUndefined()
      expect(commands).toContain(
        "gh pr checkout 1 --repo 'owner/repo' --detach",
      )
    } finally {
      await removePath(root, { force: true, recursive: true })
    }
  })

  test("serializes worktree creation for the same repository root", async () => {
    const root = await mkdtemp(join(tmpdir(), "magi-worktrees-"))
    const commands: string[] = []
    let markFirstCheckoutReached!: () => void
    let releaseFirstCheckout!: () => void
    const firstCheckoutReached = new Promise<void>((resolve) => {
      markFirstCheckoutReached = resolve
    })
    const holdFirstCheckout = new Promise<void>((resolve) => {
      releaseFirstCheckout = resolve
    })

    try {
      const first = createWorktree(
        async (command) => {
          commands.push(command)

          if (command.includes("gh pr checkout 1")) {
            markFirstCheckoutReached()
            await holdFirstCheckout
          }
          if (command === "git branch --show-current") return "branch\n"

          return ""
        },
        repository,
        1,
        root,
      )

      await firstCheckoutReached

      const second = createWorktree(
        async (command) => {
          commands.push(command)
          if (command === "git branch --show-current") return "branch\n"

          return ""
        },
        repository,
        2,
        root,
      )

      await Promise.resolve()

      expect(commands.some((command) => command.includes("pr-2"))).toBe(false)

      releaseFirstCheckout()
      await Promise.all([first, second])

      expect(
        commands.filter((command) => command.includes("pr-1")),
      ).not.toHaveLength(0)
      expect(
        commands.filter((command) => command.includes("pr-2")),
      ).not.toHaveLength(0)
    } finally {
      await removePath(root, { force: true, recursive: true })
    }
  })

  test("retries checkout when git config is locked", async () => {
    const root = await mkdtemp(join(tmpdir(), "magi-worktrees-"))
    let checkoutAttempts = 0

    try {
      await createWorktree(
        async (command) => {
          if (command.includes("gh pr checkout")) {
            checkoutAttempts += 1
            if (checkoutAttempts === 1) {
              throw new Error(
                "error: could not lock config file .git/config: File exists",
              )
            }
          }
          if (command === "git branch --show-current") return "branch\n"

          return ""
        },
        repository,
        1,
        root,
      )

      expect(checkoutAttempts).toBe(2)
    } finally {
      await removePath(root, { force: true, recursive: true })
    }
  })

  test("removes a partially created worktree after checkout failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "magi-worktrees-"))
    const commands: string[] = []
    const worktreePath = join(root, "pr-1")

    try {
      await expect(
        createWorktree(
          async (command) => {
            commands.push(command)
            if (command.includes("gh pr checkout")) {
              throw new Error("checkout failed")
            }

            return ""
          },
          repository,
          1,
          root,
        ),
      ).rejects.toThrow("checkout failed")

      expect(commands).toContain(
        `git worktree remove --force ${shellQuote(worktreePath)}`,
      )
      expect(commands).toContain("git worktree prune")
    } finally {
      await removePath(root, { force: true, recursive: true })
    }
  })
})

describe("waitForChecks", () => {
  test("returns an empty report when checks pass", async () => {
    const commands: string[] = []
    const result = await waitForChecks(
      async (command) => {
        commands.push(command)
        return ""
      },
      repository,
      1,
    )

    expect(result).toEqual({
      attempts: 0,
      excluded: [],
      failed: [],
      rerun: [],
      scopeInside: [],
      scopeOutsideRecovered: [],
      scopeOutsideUnresolved: [],
    })
    expect(commands).toHaveLength(1)
    expect(commands[0]).toContain("gh pr checks 1")
  })

  test("returns failed checks without classifying or rerunning", async () => {
    const failed = [
      {
        bucket: "fail",
        link: "https://github.com/owner/repo/actions/runs/1/job/123",
        name: "Test",
        state: "FAILURE",
        workflow: "CI",
      },
    ]

    const result = await waitForChecks(
      async (command) => {
        if (command.includes("--watch")) throw new Error("checks failed")
        if (command.includes("--json")) return JSON.stringify(failed)

        return ""
      },
      repository,
      1,
    )

    expect(result?.failed).toEqual(failed)
    expect(result?.rerun).toEqual([])
  })
})
