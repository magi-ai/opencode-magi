import { afterEach, describe, expect, test } from "vitest"
import { mkdtemp, readFile, rm as removePath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  DuplicateIssueCandidate,
  IssueComment,
  IssueMeta,
  RelatedPullRequest,
} from "../github/commands"
import type { Exec, ResolvedRepository, TriageDuplicateOutput } from "../types"
import type { ModelClient } from "./model"
import {
  chooseDuplicateOutput,
  eligibleMentionReplies,
  mentionAllowed,
  parseTriageMarker,
  resolveIssueCategory,
  runTriage,
} from "./triage"

const repository: ResolvedRepository = {
  agents: {
    reviewers: [],
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
  alias: "repo",
  automation: { close: false, merge: true },
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
    approvalPolicy: "majority",
    auto: true,
    deleteBranch: true,
    maxThreadResolutionCycles: 5,
    mergeQueue: false,
    method: "squash",
  },
  prompts: {},
  safety: { allowAuthors: [], blockedPaths: [], requiredLabels: [] },
  triage: {
    automation: {
      clear: ["triage"],
      close: false,
      create: false,
      merge: false,
      review: false,
    },
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
    safety: {
      allowAuthors: [],
      allowMentionActors: [],
      allowMentionRoles: ["MEMBER"],
      blockedLabels: [],
      requiredLabels: ["triage"],
    },
  },
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

function issue(overrides: Partial<IssueMeta> = {}): IssueMeta {
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

function issueResponse(value: IssueMeta): string {
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

function commentsResponse(values: IssueComment[]): string {
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

function createExec(input: {
  comments?: IssueComment[]
  duplicateCandidates?: DuplicateIssueCandidate[]
  issue?: IssueMeta
  relatedPullRequests?: RelatedPullRequest[]
}): { commands: string[]; exec: Exec } {
  const commands: string[] = []
  const value = input.issue ?? issue()
  const exec: Exec = async (command) => {
    commands.push(command)

    if (command.startsWith("gh auth token")) return "token\n"
    if (command.startsWith("git worktree add")) return ""
    if (command.startsWith("git config --worktree")) return ""
    if (command.startsWith("git push")) return ""
    if (command.startsWith("git worktree remove")) return ""
    if (command.startsWith("gh pr create")) {
      return "https://github.com/owner/repo/pull/30"
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
      const id = Number(command.match(/issues\/comments\/(\d+)/)?.[1] ?? "9001")

      return JSON.stringify({
        id,
        url: `https://github.com/owner/repo/issues/1#issuecomment-${id}`,
      })
    }
    if (command.startsWith("gh issue close 1")) return "closed"
    if (command.startsWith("gh issue edit 1")) return ""
    if (command.startsWith("git worktree add")) return ""
    if (command.startsWith("git config --worktree")) return ""
    if (command.startsWith("git push")) return ""
    if (command.startsWith("gh pr create")) {
      return "https://github.com/owner/repo/pull/123"
    }
    if (command.startsWith("git worktree remove")) return ""
    if (command.startsWith("git worktree prune")) return ""
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
    if (command.includes("comments(last:")) {
      return commentsResponse(input.comments ?? [])
    }
    if (command.includes("timelineItems")) {
      return relatedPullRequestsResponse(input.relatedPullRequests ?? [])
    }
    if (command.includes("issueType")) return issueResponse(value)

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

async function runScenario(input: {
  comments?: IssueComment[]
  dryRun?: boolean
  duplicateCandidates?: DuplicateIssueCandidate[]
  issue?: IssueMeta
  outputs: string[]
  relatedPullRequests?: RelatedPullRequest[]
  repository?: ResolvedRepository
}) {
  const directory = await mkdtemp(join(tmpdir(), "magi-triage-test-"))
  temporaryDirs.push(directory)
  const model = createModelClient([...input.outputs])
  const exec = createExec({
    comments: input.comments,
    duplicateCandidates: input.duplicateCandidates,
    issue: input.issue,
    relatedPullRequests: input.relatedPullRequests,
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
    repository: input.repository ?? repository,
    runId: "run-test",
  })

  return { ...exec, ...model, progress, result }
}

function vote(vote: string): string {
  return JSON.stringify({
    body: vote === "ASK" ? `${vote} body` : undefined,
    reason: `${vote} reason`,
    vote,
  })
}

function duplicateVote(vote: string, duplicateOf?: number): string {
  return JSON.stringify({ duplicateOf, reason: `${vote} reason`, vote })
}

function action(action: string): string {
  return JSON.stringify({ action, reason: `${action} reason` })
}

function decision(category: string | null, disposition: string) {
  return { category, disposition }
}

function repositoryWithTriage(
  triage: Partial<NonNullable<ResolvedRepository["triage"]>>,
): ResolvedRepository {
  return {
    ...repository,
    triage: {
      ...repository.triage!,
      ...triage,
      automation: {
        ...repository.triage!.automation,
        ...triage.automation,
      },
      safety: {
        ...repository.triage!.safety,
        ...triage.safety,
      },
    },
  }
}

describe("triage orchestration", () => {
  test("resolves issue category from configured labels and issue types", () => {
    expect(resolveIssueCategory(issue({ type: "Bug" }), repository)).toBe("bug")
    expect(resolveIssueCategory(issue({ type: "Feature" }), repository)).toBe(
      "feature",
    )
    expect(resolveIssueCategory(issue({ labels: ["bug"] }), repository)).toBe(
      "bug",
    )
    expect(
      resolveIssueCategory(issue({ labels: ["enhancement"] }), repository),
    ).toBe("feature")
    expect(resolveIssueCategory(issue({ type: undefined }), repository)).toBe(
      undefined,
    )
    expect(
      resolveIssueCategory(
        issue({ labels: ["bug"], type: "Feature" }),
        repository,
      ),
    ).toBe(undefined)
  })

  test("parses v2 triage markers", () => {
    expect(
      parseTriageMarker(
        "body\n<!-- opencode-magi:triage v=2 issue=1 category=task disposition=accepted action=COMMENT checkpoint=10 pr=none processed=11,12 -->",
      ),
    ).toMatchObject({
      action: "COMMENT",
      category: "task",
      checkpoint: 10,
      disposition: "accepted",
      issue: 1,
      processed: [11, 12],
      v: 2,
    })
    expect(
      parseTriageMarker(
        "body\n<!-- opencode-magi:triage v=2 issue=1 category=none disposition=ask askReason=category_unclear action=COMMENT checkpoint=10 pr=none processed= -->",
      ),
    ).toMatchObject({
      askReason: "category_unclear",
      category: null,
      disposition: "ask",
    })
  })

  for (const { category, type } of [
    { category: "bug", type: "Bug" },
    { category: "feature", type: "Feature" },
  ]) {
    test(`skips category classification when issue type is ${type}`, async () => {
      const result = await runScenario({
        issue: issue({ type }),
        outputs: [
          vote("YES"),
          vote("YES"),
          vote("YES"),
          action("COMMENT"),
          `${type} accepted comment`,
        ],
      })

      expect(result.result.result).toEqual(decision(category, "accepted"))
      expect(
        result.sessionTitles.filter((title) =>
          title.includes("triage acceptance"),
        ),
      ).toHaveLength(3)
      expect(
        result.sessionTitles.some((title) => title.includes("triage category")),
      ).toBe(false)
    })
  }

  test("runs category classification when issue type and category labels are absent", async () => {
    const result = await runScenario({
      issue: issue({ type: undefined }),
      outputs: [
        vote("feature"),
        vote("feature"),
        vote("ASK"),
        vote("YES"),
        vote("YES"),
        vote("YES"),
        action("COMMENT"),
        "Feature accepted comment",
      ],
    })

    expect(result.result.result).toEqual(decision("feature", "accepted"))
    expect(
      result.sessionTitles.filter((title) => title.includes("triage category")),
    ).toHaveLength(3)
    expect(
      result.sessionTitles.filter((title) =>
        title.includes("triage acceptance"),
      ),
    ).toHaveLength(3)
  })

  test("asks without category details when category is unclear", async () => {
    const result = await runScenario({
      issue: issue({ type: undefined }),
      outputs: [vote("ASK"), vote("ASK"), vote("bug"), action("ASK")],
    })
    const comment = await readFile(
      join(result.result.outputDir, "Melchior.ask-comment.md"),
      "utf8",
    )
    const visibleComment = comment.split("<!-- opencode-magi:triage")[0]

    expect(result.result.result).toEqual({
      askReason: "category_unclear",
      category: null,
      disposition: "ask",
    })
    expect(visibleComment).toContain("ASK body")
    expect(visibleComment).not.toContain("bug")
    expect(visibleComment).not.toContain("feature")
  })

  test("blocks unsafe issues before model classification", async () => {
    const result = await runScenario({
      issue: issue({ labels: [] }),
      outputs: [],
    })

    expect(result.result.result).toEqual(decision(null, "failed"))
    expect(result.result.report).toContain("missing required labels: triage")
    expect(result.sessionTitles).toEqual([])
  })

  test("detects explicit duplicate candidates before category classification", async () => {
    const result = await runScenario({
      issue: issue({ body: "Duplicate of #10" }),
      outputs: [
        duplicateVote("DUPLICATE", 10),
        duplicateVote("DUPLICATE", 10),
        duplicateVote("NOT_DUPLICATE"),
        action("COMMENT"),
        "Duplicate comment",
      ],
    })

    expect(result.result.result).toEqual(decision(null, "duplicate"))
    expect(
      result.sessionTitles.filter((title) =>
        title.includes("triage duplicate"),
      ),
    ).toHaveLength(3)
    expect(
      result.sessionTitles.some((title) => title.includes("triage category")),
    ).toBe(false)
  })

  test("clears triage only when an open related PR already handles the issue", async () => {
    const result = await runScenario({
      outputs: [
        vote("RELATED_PR_HANDLES_ISSUE"),
        vote("RELATED_PR_HANDLES_ISSUE"),
        vote("RELATED_PR_DOES_NOT_HANDLE_ISSUE"),
        action("CLEAR_ONLY"),
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

    expect(result.result.result).toEqual(decision(null, "clear_only"))
    expect(
      result.sessionTitles.filter((title) =>
        title.includes("triage existing PR"),
      ),
    ).toHaveLength(3)
    expect(
      result.sessionTitles.some((title) => title.includes("triage category")),
    ).toBe(false)
  })

  test("closes the issue when a merged related PR handles it and close automation is enabled", async () => {
    const result = await runScenario({
      dryRun: false,
      outputs: [
        vote("RELATED_PR_HANDLES_ISSUE"),
        vote("RELATED_PR_HANDLES_ISSUE"),
        vote("RELATED_PR_DOES_NOT_HANDLE_ISSUE"),
        action("CLOSE"),
        "Merged PR comment",
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
      repository: repositoryWithTriage({
        automation: {
          close: true,
          clear: ["triage"],
          create: false,
          merge: false,
          review: false,
        },
      }),
    })

    expect(result.result.result).toEqual(decision(null, "accepted"))
    expect(
      result.commands.some((command) => command.startsWith("gh issue close 1")),
    ).toBe(true)
    expect(
      result.commands.some((command) =>
        command.includes("--remove-label 'triage'"),
      ),
    ).toBe(true)
  })

  test("closes intentionally invalid issues when acceptance vote rejects them", async () => {
    const result = await runScenario({
      dryRun: false,
      issue: issue({
        body: "This bug report is intentionally wrong.",
        type: "Bug",
      }),
      outputs: [
        vote("NO"),
        vote("NO"),
        vote("ASK"),
        action("CLOSE"),
        "Rejected bug comment",
      ],
      repository: repositoryWithTriage({
        automation: {
          close: true,
          clear: ["triage"],
          create: false,
          merge: false,
          review: false,
        },
      }),
    })

    expect(result.result.result).toEqual(decision("bug", "rejected"))
    expect(
      result.commands.some((command) => command.startsWith("gh issue close 1")),
    ).toBe(true)
  })

  test("assigns the issue to the triage creator account before creating an implementation PR", async () => {
    const result = await runScenario({
      dryRun: false,
      issue: issue({ type: "Feature" }),
      outputs: [
        vote("YES"),
        vote("YES"),
        vote("YES"),
        action("PR"),
        JSON.stringify({
          commitMessage: "fix(orchestrator): address issue",
          commitSha: "abc123",
          filesTouched: ["src/example.ts"],
          mode: "EDITED",
          pullRequest: {
            body: "Custom PR body from creator",
            title: "fix(triage): use creator PR metadata",
          },
          responses: [{ action: "FIXED", body: "Fixed.", commentId: 1 }],
        }),
      ],
      repository: {
        ...repositoryWithTriage({
          automation: {
            close: false,
            clear: ["triage"],
            create: true,
            merge: false,
            review: false,
          },
        }),
        agents: {
          ...repository.agents,
          triageCreator: {
            account: "creator-bot",
            author: { email: "creator@example.com", name: "Creator Bot" },
            model: "mock/model",
            permission: "deny",
          },
        },
      },
    })

    const assignIndex = result.commands.findIndex((command) =>
      command.includes("--add-assignee 'creator-bot'"),
    )
    const worktreeIndex = result.commands.findIndex((command) =>
      command.startsWith("git worktree add"),
    )
    const prIndex = result.commands.findIndex((command) =>
      command.startsWith("gh pr create"),
    )

    expect(result.result.result).toEqual(decision("feature", "accepted"))
    expect(assignIndex).toBeGreaterThan(-1)
    expect(assignIndex).toBeLessThan(worktreeIndex)
    expect(assignIndex).toBeLessThan(prIndex)
    expect(result.commands[prIndex]).toContain(
      "--title 'fix(triage): use creator PR metadata'",
    )
    expect(result.commands[prIndex]).toContain(
      "--body 'Custom PR body from creator'",
    )
    expect(result.progress).toEqual(
      expect.arrayContaining([
        { phase: "acceptance", type: "phase" },
        {
          action: "PR",
          result: decision("feature", "accepted"),
          type: "decision",
        },
        { type: "comment_posting" },
        {
          type: "comment_posted",
          url: "https://github.com/owner/repo/issues/1#issuecomment-9001",
        },
        { type: "pr_creation_started" },
        { type: "triage_creator_started" },
        {
          sessionId: expect.any(String),
          type: "triage_creator_session",
        },
        {
          sessionId: expect.any(String),
          type: "triage_creator_completed",
        },
        {
          type: "pr_created",
          url: "https://github.com/owner/repo/pull/30",
        },
      ]),
    )
  })

  test("skips reconsideration when a previous marker has no eligible mentions", async () => {
    const result = await runScenario({
      comments: [
        comment({
          author: "melchior-bot",
          body: "Previous comment\n\n<!-- opencode-magi:triage v=1 issue=1 result=BUG_ACCEPTED action=COMMENT checkpoint=10 pr=none processed= -->",
          id: 10,
        }),
      ],
      issue: issue({ labels: [] }),
      outputs: [],
    })

    expect(result.result.result).toEqual(decision("bug", "accepted"))
    expect(result.sessionTitles).toEqual([])
  })

  test("resumes unfinished PR automation from a previous marker", async () => {
    const result = await runScenario({
      comments: [
        comment({
          author: "melchior-bot",
          body: "Previous comment\n\n<!-- opencode-magi:triage v=1 issue=1 result=FEATURE_ACCEPTED action=PR checkpoint=10 pr=none processed= -->",
          id: 10,
        }),
      ],
      dryRun: false,
      issue: issue({ type: "Feature" }),
      outputs: [
        action("PR"),
        JSON.stringify({
          commitMessage: "fix: address issue #1",
          commitSha: "abcdef1234567890",
          filesTouched: ["src/app.ts"],
          mode: "EDITED",
          pullRequest: {
            body: "Closes #1",
            title: "fix: address issue #1",
          },
          responses: [],
        }),
      ],
      repository: {
        ...repositoryWithTriage({
          automation: {
            close: false,
            clear: ["triage"],
            create: true,
            merge: false,
            review: false,
          },
        }),
        agents: {
          ...repository.agents,
          triageCreator: {
            account: "creator-bot",
            author: { email: "bot@example.com", name: "Magi Bot" },
            model: "mock/model",
            permission: "deny",
          },
        },
      },
    })

    expect(result.result.result).toEqual(decision("feature", "accepted"))
    expect(result.result.report).toContain(
      "Created PR: https://github.com/owner/repo/pull/30",
    )
    expect(result.sessionTitles).toEqual([
      "Magi triage action #1",
      "Magi triage create PR #1",
    ])
    expect(
      result.commands.some((command) =>
        command.includes("--remove-label 'triage'"),
      ),
    ).toBe(true)
  })

  test("resumes unfinished close automation from a previous marker", async () => {
    const result = await runScenario({
      comments: [
        comment({
          author: "melchior-bot",
          body: "Previous comment\n\n<!-- opencode-magi:triage v=1 issue=1 result=BUG_REJECTED action=CLOSE checkpoint=10 pr=none processed= -->",
          id: 10,
        }),
      ],
      dryRun: false,
      outputs: [action("CLOSE")],
      repository: repositoryWithTriage({
        automation: {
          close: true,
          clear: ["triage"],
          create: false,
          merge: false,
          review: false,
        },
      }),
    })

    expect(result.result.result).toEqual(decision("bug", "rejected"))
    expect(
      result.commands.some((command) => command.startsWith("gh issue close 1")),
    ).toBe(true)
    expect(
      result.commands.some((command) =>
        command.includes("--remove-label 'triage'"),
      ),
    ).toBe(true)
  })

  test("does not create a PR from a previous comment-only marker", async () => {
    const result = await runScenario({
      comments: [
        comment({
          author: "melchior-bot",
          body: "Previous comment\n\n<!-- opencode-magi:triage v=1 issue=1 result=FEATURE_ACCEPTED action=COMMENT checkpoint=10 pr=none processed= -->",
          id: 10,
        }),
      ],
      dryRun: false,
      issue: issue({ type: "Feature" }),
      outputs: [action("CLEAR_ONLY")],
      repository: {
        ...repositoryWithTriage({
          automation: {
            close: false,
            clear: ["triage"],
            create: true,
            merge: false,
            review: false,
          },
        }),
        agents: {
          ...repository.agents,
          triageCreator: {
            account: "creator-bot",
            author: { email: "bot@example.com", name: "Magi Bot" },
            model: "mock/model",
            permission: "deny",
          },
        },
      },
    })

    expect(result.result.result).toEqual(decision("feature", "accepted"))
    expect(
      result.commands.some((command) => command.startsWith("git worktree add")),
    ).toBe(false)
    expect(
      result.commands.some((command) => command.startsWith("gh pr create")),
    ).toBe(false)
    expect(
      result.commands.some((command) =>
        command.includes("--remove-label 'triage'"),
      ),
    ).toBe(true)
  })

  test("clears labels before creating implementation PRs", async () => {
    const result = await runScenario({
      dryRun: false,
      issue: issue({ type: "Feature" }),
      outputs: [
        vote("YES"),
        vote("YES"),
        vote("YES"),
        action("PR"),
        "Feature accepted comment",
        JSON.stringify({
          commitMessage: "fix: address issue #1",
          commitSha: "abcdef1234567890",
          filesTouched: ["src/app.ts"],
          mode: "EDITED",
          pullRequest: {
            body: "Closes #1",
            title: "fix: address issue #1",
          },
          responses: [],
        }),
      ],
      repository: {
        ...repositoryWithTriage({
          automation: {
            close: false,
            clear: ["triage"],
            create: true,
            merge: false,
            review: false,
          },
        }),
        agents: {
          ...repository.agents,
          triageCreator: {
            account: "creator-bot",
            author: { email: "bot@example.com", name: "Magi Bot" },
            model: "mock/model",
            permission: "deny",
          },
        },
      },
    })

    const removeLabelIndex = result.commands.findIndex((command) =>
      command.includes("--remove-label 'triage'"),
    )
    const worktreeIndex = result.commands.findIndex((command) =>
      command.startsWith("git worktree add"),
    )

    expect(removeLabelIndex).toBeGreaterThan(-1)
    expect(worktreeIndex).toBeGreaterThan(-1)
    expect(removeLabelIndex).toBeLessThan(worktreeIndex)
  })

  test("runs reconsideration for eligible mention replies", async () => {
    const result = await runScenario({
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
        vote("NO"),
        vote("NO"),
        vote("ASK"),
        action("COMMENT"),
        "Reconsidered comment",
      ],
      repository: {
        ...repository,
        agents: {
          ...repository.agents,
          triage: repository.agents.triage?.map((agent) =>
            agent.key === "Balthasar"
              ? { ...agent, persona: "Reporter persona" }
              : agent,
          ),
        },
        triage: {
          ...repository.triage!,
          reporter: "Balthasar",
        },
      },
    })

    expect(result.result.result).toEqual(decision("feature", "rejected"))
    expect(result.prompts[0]).toContain("Reporter persona")
    expect(result.progress).toEqual(
      expect.arrayContaining([
        {
          agent: "Balthasar",
          key: expect.stringContaining(
            "triage:comment-classification:Balthasar:session-1",
          ),
          sessionId: "session-1",
          type: "triage_session",
        },
      ]),
    )
    expect(
      result.sessionTitles.some((title) =>
        title.includes("triage comment classification #1 (Balthasar)"),
      ),
    ).toBe(true)
    expect(
      result.sessionTitles.filter((title) =>
        title.includes("triage reconsider"),
      ),
    ).toHaveLength(3)
  })

  for (const { candidateNumbers, expectedDuplicateOf, outputs, title } of [
    {
      candidateNumbers: [101, 202],
      outputs: [
        { duplicateOf: 101, reason: "same failure", vote: "DUPLICATE" },
        { duplicateOf: 202, reason: "same request", vote: "DUPLICATE" },
        { reason: "not the same", vote: "NOT_DUPLICATE" },
      ],
      title: "requires majority support for the same duplicate target",
    },
    {
      candidateNumbers: [101, 202],
      expectedDuplicateOf: 101,
      outputs: [
        { duplicateOf: 101, reason: "same failure", vote: "DUPLICATE" },
        { duplicateOf: 101, reason: "same root cause", vote: "DUPLICATE" },
        { duplicateOf: 202, reason: "similar request", vote: "DUPLICATE" },
      ],
      title: "selects a duplicate target with majority support",
    },
    {
      candidateNumbers: [101],
      outputs: [
        { duplicateOf: 999, reason: "invalid target", vote: "DUPLICATE" },
        { duplicateOf: 999, reason: "invalid target", vote: "DUPLICATE" },
        { reason: "not the same", vote: "NOT_DUPLICATE" },
      ],
      title: "ignores duplicate targets that were not provided as candidates",
    },
  ] satisfies {
    candidateNumbers: number[]
    expectedDuplicateOf?: number
    outputs: TriageDuplicateOutput[]
    title: string
  }[]) {
    test(title, () => {
      const result = chooseDuplicateOutput({ candidateNumbers, outputs })

      if (expectedDuplicateOf == null) expect(result).toBeUndefined()
      else expect(result?.duplicateOf).toBe(expectedDuplicateOf)
    })
  }

  test("allows reconsideration mentions by actor or role", () => {
    expect(
      mentionAllowed(comment({ authorAssociation: "MEMBER" }), repository),
    ).toBe(true)
    expect(
      mentionAllowed(comment({ authorAssociation: "CONTRIBUTOR" }), repository),
    ).toBe(false)
    expect(
      mentionAllowed(comment({ author: "maintainer" }), {
        ...repository,
        triage: {
          ...repository.triage!,
          safety: {
            ...repository.triage!.safety,
            allowMentionActors: ["maintainer"],
            allowMentionRoles: [],
          },
        },
      }),
    ).toBe(true)
  })

  test("selects unprocessed allowed mention replies after marker checkpoint", () => {
    const replies = eligibleMentionReplies({
      account: "magi-bot",
      comments: [
        comment({ body: "old @magi-bot", id: 9, authorAssociation: "MEMBER" }),
        comment({
          body: "processed @magi-bot",
          id: 11,
          authorAssociation: "MEMBER",
        }),
        comment({
          body: "allowed @magi-bot",
          id: 12,
          authorAssociation: "MEMBER",
        }),
        comment({
          body: "not allowed @magi-bot",
          id: 13,
          authorAssociation: "CONTRIBUTOR",
        }),
        comment({ body: "no mention", id: 14, authorAssociation: "MEMBER" }),
      ],
      marker: { commentId: 10, processed: [11], v: 1 },
      processed: [11],
      repository,
    })

    expect(replies.map((reply) => reply.id)).toEqual([12])
  })
})
