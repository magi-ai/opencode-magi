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
  waitForAutoMerge,
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

  test("falls back to gh issue view without issue type when issueType is unavailable", async () => {
    const commands: string[] = []

    const result = await fetchIssue(
      async (value) => {
        commands.push(value)
        if (value.includes("graphql")) {
          throw new Error(
            'GraphQL: Cannot query field "issueType" on type "Issue".',
          )
        }

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

  test("surfaces non-issueType GraphQL command failures", async () => {
    const commands: string[] = []

    await expect(
      fetchIssue(
        async (value) => {
          commands.push(value)
          throw new Error("authentication required")
        },
        repository,
        56,
      ),
    ).rejects.toThrow("authentication required")

    expect(commands).toHaveLength(1)
    expect(commands[0]).toContain("gh api graphql")
  })

  test("surfaces malformed GraphQL issue responses", async () => {
    const commands: string[] = []

    await expect(
      fetchIssue(
        async (value) => {
          commands.push(value)
          return "not json"
        },
        repository,
        56,
      ),
    ).rejects.toThrow()

    expect(commands).toHaveLength(1)
    expect(commands[0]).toContain("gh api graphql")
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
      "gh search issues --repo 'owner/repo' --json number,title,url,state,body --limit 5 -- 'Align docs config md triage prompts entries with review and merge prompts'",
    ])
    expect(result.map((item) => item.number)).toEqual([43])
  })

  test("sanitizes duplicate issue search queries with slash-prefixed command titles", async () => {
    const commands: string[] = []

    const result = await searchDuplicateIssues(
      async (command) => {
        commands.push(command)

        return "[]"
      },
      repository,
      {
        author: "author",
        body: "body",
        labels: [],
        number: 141,
        state: "OPEN",
        title:
          "/magi:merge skips editor when existing CHANGES_REQUESTED review has only body-level requirement findings",
        url: "https://github.com/owner/repo/issues/141",
      },
    )

    expect(commands).toEqual([
      "gh search issues --repo 'owner/repo' --json number,title,url,state,body --limit 5 -- 'magi merge skips editor when existing CHANGES_REQUESTED review has only body level requirement findings'",
    ])
    expect(result).toEqual([])
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

  test("waits for auto-merge completion", async () => {
    const commands: string[] = []
    const statuses = [
      {
        autoMergeRequest: { enabledAt: "2026-01-01T00:00:00Z" },
        mergeStateStatus: "BLOCKED",
        state: "OPEN",
      },
      { autoMergeRequest: null, mergeStateStatus: "UNKNOWN", state: "MERGED" },
    ]

    const result = await waitForAutoMerge(
      async (command) => {
        commands.push(command)

        return JSON.stringify(statuses.shift())
      },
      repository,
      7557,
      0,
    )

    expect(result).toBe("merged")
    expect(commands[0]).toContain(
      "--json state,mergeStateStatus,autoMergeRequest",
    )
    expect(commands).toHaveLength(2)
  })

  test("returns dequeued when auto-merge is removed before merging", async () => {
    const result = await waitForAutoMerge(
      async () =>
        JSON.stringify({
          autoMergeRequest: null,
          mergeStateStatus: "CLEAN",
          state: "OPEN",
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
    expect(commands[1]).not.toContain("GH_TOKEN")
    expect(options[1]?.env?.GH_TOKEN).toBe("token")
    expect(payload).toEqual({
      body: "This PR should be closed.",
      event: "COMMENT",
    })
  })

  test("posts all findings as inline comments with a summary body", async () => {
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
          issue: "Findings must create review threads.",
          line: 20,
          path: "src/orchestrator/merge.ts",
        },
        {
          fix: "Validate only inline targets.",
          issue: "Inline validation rejects file-level findings.",
          line: 10,
          path: "src/orchestrator/review.ts",
        },
      ],
    )

    expect(payload?.event).toBe("REQUEST_CHANGES")
    expect(payload?.comments).toEqual([
      {
        body: "**Issue:** Findings must create review threads.\n\n**Fix:** Pass structured findings to the editor.",
        line: 20,
        path: "src/orchestrator/merge.ts",
        side: "RIGHT",
      },
      {
        body: "**Issue:** Inline validation rejects file-level findings.\n\n**Fix:** Validate only inline targets.",
        line: 10,
        path: "src/orchestrator/review.ts",
        side: "RIGHT",
      },
    ])
    expect(payload?.body).toBe("Changes requested: 2 inline comments.")
    expect(payload?.body).not.toContain("File-level findings:")
    expect(payload?.body).not.toContain("Requirement findings:")
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
      "-f query='query($owner: String!, $repo: String!, $pr: Int!, $cursor: String)",
    )
    expect(graphqlCommand).toContain("-F owner='owner'")
    expect(graphqlCommand).toContain("-F repo='repo'")
    expectBalancedBraces(extractGraphqlQuery(graphqlCommand))
  })

  test("normalizes PR review comments from GraphQL review nodes", async () => {
    const reviews = await fetchPullRequestReviews(
      async () =>
        JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviews: {
                  nodes: [
                    {
                      author: { login: "bot-a" },
                      body: "Changes requested: 1 inline comment.",
                      comments: {
                        nodes: [
                          {
                            body: "**Issue:** Keep finding.\n\n**Fix:** Restore it.",
                            line: 20,
                            path: "src/orchestrator/review.ts",
                            startLine: 18,
                          },
                        ],
                      },
                      commit: { oid: "head" },
                      state: "CHANGES_REQUESTED",
                      submittedAt: "2026-01-01T00:00:00Z",
                    },
                  ],
                },
              },
            },
          },
        }),
      repository,
      7557,
    )

    expect(reviews).toEqual([
      {
        author: { login: "bot-a" },
        body: "Changes requested: 1 inline comment.",
        comments: [
          {
            body: "**Issue:** Keep finding.\n\n**Fix:** Restore it.",
            line: 20,
            path: "src/orchestrator/review.ts",
            startLine: 18,
          },
        ],
        commit: { oid: "head" },
        state: "CHANGES_REQUESTED",
        submittedAt: "2026-01-01T00:00:00Z",
      },
    ])
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

  test("paginates pull request reviews", async () => {
    const commands: string[] = []
    const reviews = await fetchPullRequestReviews(
      async (command) => {
        commands.push(command)

        return JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviews: command.includes("-F cursor='reviews-cursor'")
                  ? {
                      nodes: [
                        {
                          author: { login: "reviewer-b" },
                          body: "LGTM",
                          commit: { oid: "commit-b" },
                          state: "APPROVED",
                          submittedAt: "2026-01-01T00:00:01Z",
                        },
                      ],
                      pageInfo: { endCursor: undefined, hasNextPage: false },
                    }
                  : {
                      nodes: [
                        {
                          author: { login: "reviewer-a" },
                          body: "Please change this.",
                          commit: { oid: "commit-a" },
                          state: "CHANGES_REQUESTED",
                          submittedAt: "2026-01-01T00:00:00Z",
                        },
                      ],
                      pageInfo: {
                        endCursor: "reviews-cursor",
                        hasNextPage: true,
                      },
                    },
              },
            },
          },
        })
      },
      repository,
      7557,
    )

    expect(reviews.map((review) => review.author.login)).toEqual([
      "reviewer-a",
      "reviewer-b",
    ])
    expect(commands).toHaveLength(2)
    expect(commands[1]).toContain("-F cursor='reviews-cursor'")
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

  test("paginates pull request commits", async () => {
    const commands: string[] = []
    const commits = await fetchPullRequestCommits(
      async (command) => {
        commands.push(command)

        return JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                commits: command.includes("-F cursor='commits-cursor'")
                  ? {
                      nodes: [
                        {
                          commit: {
                            committedDate: "2026-01-01T00:00:01Z",
                            oid: "commit-b",
                            parents: { totalCount: 1 },
                          },
                        },
                      ],
                      pageInfo: { endCursor: undefined, hasNextPage: false },
                    }
                  : {
                      nodes: [
                        {
                          commit: {
                            committedDate: "2026-01-01T00:00:00Z",
                            oid: "commit-a",
                            parents: { totalCount: 1 },
                          },
                        },
                      ],
                      pageInfo: {
                        endCursor: "commits-cursor",
                        hasNextPage: true,
                      },
                    },
              },
            },
          },
        })
      },
      repository,
      7557,
    )

    expect(commits.map((commit) => commit.oid)).toEqual([
      "commit-a",
      "commit-b",
    ])
    expect(commands).toHaveLength(2)
    expect(commands[1]).toContain("-F cursor='commits-cursor'")
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

  test("paginates unresolved review threads and comments", async () => {
    const commands: string[] = []
    const threads = await fetchUnresolvedThreads(
      async (command) => {
        commands.push(command)

        if (command.includes("-F threadId='thread-a'")) {
          return JSON.stringify({
            data: {
              node: {
                comments: {
                  nodes: [
                    {
                      author: { login: "author" },
                      body: "Follow-up.",
                      createdAt: "2026-01-01T00:00:01Z",
                      databaseId: 124,
                      line: 10,
                      path: "src/app.ts",
                    },
                  ],
                  pageInfo: { endCursor: undefined, hasNextPage: false },
                },
              },
            },
          })
        }

        return JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: command.includes("-F cursor='threads-cursor'")
                  ? {
                      nodes: [
                        {
                          comments: {
                            nodes: [
                              {
                                author: { login: "bot-b" },
                                body: "Fix that.",
                                createdAt: "2026-01-01T00:00:02Z",
                                databaseId: 125,
                                line: 20,
                                path: "src/next.ts",
                              },
                            ],
                            pageInfo: {
                              endCursor: undefined,
                              hasNextPage: false,
                            },
                          },
                          id: "thread-b",
                          isResolved: false,
                        },
                      ],
                      pageInfo: { endCursor: undefined, hasNextPage: false },
                    }
                  : {
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
                            pageInfo: {
                              endCursor: "comments-cursor",
                              hasNextPage: true,
                            },
                          },
                          id: "thread-a",
                          isResolved: false,
                        },
                      ],
                      pageInfo: {
                        endCursor: "threads-cursor",
                        hasNextPage: true,
                      },
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
          {
            author: "author",
            body: "Follow-up.",
            commentId: 124,
            createdAt: "2026-01-01T00:00:01Z",
          },
        ],
        line: 10,
        path: "src/app.ts",
        threadId: "thread-a",
      },
      {
        body: "Fix that.",
        commentId: 125,
        comments: [
          {
            author: "bot-b",
            body: "Fix that.",
            commentId: 125,
            createdAt: "2026-01-01T00:00:02Z",
          },
        ],
        line: 20,
        path: "src/next.ts",
        threadId: "thread-b",
      },
    ])
    expect(commands).toHaveLength(3)
    expect(commands[1]).toContain("-F threadId='thread-a'")
    expect(commands[1]).toContain("-F cursor='comments-cursor'")
    expect(commands[2]).toContain("-F cursor='threads-cursor'")
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
    const worktreePath = join(root, "1", "run-test")
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
        worktreePath,
      )

      expect(result.branch).toBeUndefined()
      expect(result.path).toBe(worktreePath)
      expect(commands).toContain(
        "gh pr checkout 1 --repo 'owner/repo' --detach",
      )
    } finally {
      await removePath(root, { force: true, recursive: true })
    }
  })

  test("serializes worktree creation for the same repository root", async () => {
    const root = await mkdtemp(join(tmpdir(), "magi-worktrees-"))
    const firstWorktreePath = join(root, "1", "run-first")
    const secondWorktreePath = join(root, "2", "run-second")
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
        firstWorktreePath,
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
        secondWorktreePath,
      )

      await Promise.resolve()

      expect(commands.some((command) => command.includes("run-second"))).toBe(
        false,
      )

      releaseFirstCheckout()
      await Promise.all([first, second])

      expect(
        commands.filter((command) => command.includes("run-first")),
      ).not.toHaveLength(0)
      expect(
        commands.filter((command) => command.includes("run-second")),
      ).not.toHaveLength(0)
    } finally {
      await removePath(root, { force: true, recursive: true })
    }
  })

  test("retries checkout when git config is locked", async () => {
    const root = await mkdtemp(join(tmpdir(), "magi-worktrees-"))
    const worktreePath = join(root, "1", "run-test")
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
        worktreePath,
      )

      expect(checkoutAttempts).toBe(2)
    } finally {
      await removePath(root, { force: true, recursive: true })
    }
  })

  test("removes a partially created worktree after checkout failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "magi-worktrees-"))
    const commands: string[] = []
    const worktreePath = join(root, "1", "run-test")

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
          worktreePath,
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
