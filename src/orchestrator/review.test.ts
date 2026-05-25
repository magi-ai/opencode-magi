import type { PullRequestMeta, PullRequestReview } from "../github/commands"
import type { Exec, MagiConfig, ResolvedRepository } from "../types"
import type { ModelClient } from "./model"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import {
  hasPendingThreadReply,
  inlineCommentTargetsForDiff,
  mergeConflictContextForDiff,
  runReview,
  reviewOutputFromState,
  resolveReviewMode,
  reviewFreshnessTarget,
} from "./review"

const accounts = ["bot-a", "bot-b", "bot-c"]

const repository: ResolvedRepository = {
  agents: {
    reviewers: accounts.map((account, index) => ({
      account,
      index,
      key: `reviewer-${index + 1}`,
      model: "provider/model",
      permission: { read: "allow" },
      persona: `Reviewer ${index + 1}`,
    })),
  },
  alias: "repo",
  automation: { close: true, merge: true },
  checks: {
    exclude: [],
    retryFailedJobs: 0,
    waitAfterEdit: false,
    waitBeforeReview: false,
  },
  concurrency: { runs: 1, reviewers: 1 },
  github: {
    apiRetryAttempts: 3,
    host: "github.example.com",
    owner: "owner",
    repo: "repo",
  },
  merge: {
    approvalPolicy: "majority",
    auto: false,
    deleteBranch: false,
    maxThreadResolutionCycles: 1,
    mergeQueue: false,
    method: "squash",
  },
  prompts: {},
  safety: { allowAuthors: [], blockedPaths: [], requiredLabels: [] },
}

const pullRequestMeta: PullRequestMeta = {
  author: { login: "author" },
  baseRefName: "main",
  baseRefOid: "base-sha",
  headRefName: "feature-branch",
  headRefOid: "head-sha",
  headRepository: { name: "repo" },
  headRepositoryOwner: { login: "owner" },
  isDraft: false,
  number: 7,
  title: "Fix diff targets",
  url: "https://github.example.com/owner/repo/pull/7",
}

function review(account: string, commit: string, submittedAt: string) {
  return {
    author: { login: account },
    commit: { oid: commit },
    state: "APPROVED",
    submittedAt,
  } satisfies PullRequestReview
}

function graphqlResponse(value: unknown): string {
  return JSON.stringify({ data: { repository: { pullRequest: value } } })
}

function fakeExec(
  commands: string[],
  options: { diff?: string; mergeTree?: string } = {},
): Exec {
  return async (command) => {
    commands.push(command)

    if (command.startsWith("gh pr view ")) {
      return JSON.stringify({
        author: { login: "author" },
        baseRefName: "main",
        baseRefOid: "base",
        body: "Review this PR.",
        changedFiles: 1,
        headRefName: "feature",
        headRefOid: "head",
        isDraft: false,
        number: 1,
        state: "OPEN",
        title: "Feature",
        url: "https://github.com/owner/repo/pull/1",
      })
    }

    if (command.includes("reviews(first: 100")) {
      return graphqlResponse({
        reviews: {
          nodes: [
            {
              author: { login: "bot-a" },
              body: "Previous review.",
              commit: { oid: "old" },
              state: "APPROVED",
              submittedAt: "2026-01-01T00:00:00Z",
            },
          ],
          pageInfo: { hasNextPage: false },
        },
      })
    }

    if (command.includes("commits(first: 100")) {
      return graphqlResponse({
        commits: {
          nodes: [
            {
              commit: {
                committedDate: "2026-01-02T00:00:00Z",
                oid: "head",
                parents: { totalCount: 1 },
              },
            },
          ],
          pageInfo: { hasNextPage: false },
        },
      })
    }

    if (command.includes("comments(last:")) {
      return graphqlResponse({ comments: { nodes: [], totalCount: 0 } })
    }

    if (command.includes("reviewThreads(last:")) {
      return graphqlResponse({ reviewThreads: { nodes: [], totalCount: 0 } })
    }

    if (command.includes("reviewThreads(first:")) {
      return graphqlResponse({ reviewThreads: { nodes: [] } })
    }

    if (command.includes("changedFiles labels")) {
      return graphqlResponse({
        author: { login: "author" },
        changedFiles: 1,
        files: {
          nodes: [{ path: "src/app.ts" }],
          pageInfo: { hasNextPage: false },
        },
        labels: { nodes: [] },
      })
    }

    if (command.includes("closingIssuesReferences")) {
      return graphqlResponse({ closingIssuesReferences: { nodes: [] } })
    }

    if (command.startsWith("gh pr checks ")) return "[]"
    if (command.startsWith("git worktree add ")) return ""
    if (command.startsWith("gh pr checkout ")) return ""
    if (command === "git branch --show-current") return "feature"
    if (command.startsWith("git cat-file -e ")) return ""
    if (command.startsWith("git diff ")) return options.diff ?? ""
    if (command.startsWith("git merge-base ")) return "merge-base"
    if (command.startsWith("git merge-tree ")) return options.mergeTree ?? ""

    throw new Error(`Unexpected command: ${command}`)
  }
}

function fakeClient(outputs: string[], prompts: string[]): ModelClient {
  let session = 0

  return {
    session: {
      async create() {
        session += 1
        return { id: `session-${session}` }
      },
      async prompt(input) {
        const parts = input.body.parts as { text?: string }[] | undefined

        prompts.push(String(parts?.[0]?.text ?? ""))
        const text = outputs.shift()

        if (!text) throw new Error("No model output queued")

        return { info: { text } }
      },
    },
  }
}

function expectActiveAssignments(
  mode: ReturnType<typeof resolveReviewMode>,
  assignments: string[],
) {
  expect(mode.type).toBe("active")
  if (mode.type !== "active") throw new Error("expected active mode")
  expect([...mode.assignments.values()].map((item) => item.type)).toEqual(
    assignments,
  )
}

describe("review", () => {
  for (const {
    expectedAssignments,
    pendingThreadReplyAccounts,
    reviews,
    title,
  } of [
    {
      expectedAssignments: ["initial", "initial", "initial"],
      reviews: [],
      title: "uses initial review when no configured account reviewed",
    },
    {
      expectedAssignments: ["skip", "rereview", "skip"],
      pendingThreadReplyAccounts: new Set(["bot-b"]),
      reviews: [
        review("bot-a", "head", "2026-01-01T00:00:00Z"),
        review("bot-b", "head", "2026-01-01T00:00:01Z"),
        review("bot-c", "head", "2026-01-01T00:00:02Z"),
      ],
      title:
        "uses rereview when a reviewed head account has a pending thread reply",
    },
    {
      expectedAssignments: ["rereview", "rereview", "rereview"],
      reviews: [
        review("bot-a", "old", "2026-01-01T00:00:00Z"),
        review("bot-b", "old", "2026-01-01T00:00:01Z"),
        review("bot-c", "old", "2026-01-01T00:00:02Z"),
      ],
      title: "uses rereview when configured accounts reviewed an older commit",
    },
    {
      expectedAssignments: ["skip", "initial", "initial"],
      reviews: [review("bot-a", "head", "2026-01-01T00:00:00Z")],
      title: "skips reviewed head accounts and reviews missing accounts",
    },
    {
      expectedAssignments: ["skip", "rereview", "initial"],
      reviews: [
        review("bot-a", "head", "2026-01-01T00:00:00Z"),
        review("bot-b", "old", "2026-01-01T00:00:01Z"),
      ],
      title: "mixes skip, rereview, and initial assignments",
    },
  ]) {
    test(title, () => {
      const mode = resolveReviewMode(
        reviews,
        accounts,
        { headSha: "head", type: "head" },
        pendingThreadReplyAccounts,
      )

      expectActiveAssignments(mode, expectedAssignments)
    })
  }

  test("aborts when all configured accounts already reviewed head", () => {
    expect(
      resolveReviewMode(
        [
          review("bot-a", "head", "2026-01-01T00:00:00Z"),
          review("bot-b", "head", "2026-01-01T00:00:01Z"),
          review("bot-c", "head", "2026-01-01T00:00:02Z"),
        ],
        accounts,
        { headSha: "head", type: "head" },
      ),
    ).toMatchObject({ type: "already_reviewed" })
  })

  test("uses latest non-merge commit time for review freshness", () => {
    const target = reviewFreshnessTarget(
      [
        {
          committedDate: "2026-01-01T00:00:00Z",
          oid: "feature",
          parentCount: 1,
        },
        {
          committedDate: "2026-01-02T00:00:00Z",
          oid: "merge",
          parentCount: 2,
        },
      ],
      "merge",
    )
    const mode = resolveReviewMode(
      [
        review("bot-a", "feature", "2026-01-01T00:00:01Z"),
        review("bot-b", "feature", "2026-01-01T00:00:02Z"),
        review("bot-c", "feature", "2026-01-01T00:00:03Z"),
      ],
      accounts,
      target,
    )

    expect(mode.type).toBe("already_reviewed")
  })

  test("builds inline targets from the prompted three-dot diff range", async () => {
    const calls: { command: string; cwd?: string }[] = []
    const targets = await inlineCommentTargetsForDiff({
      exec: async (command, options) => {
        calls.push({ command, cwd: options?.cwd })

        return [
          "diff --git a/src/app.ts b/src/app.ts",
          "--- a/src/app.ts",
          "+++ b/src/app.ts",
          "@@ -1 +1,2 @@",
          " existing",
          "+added",
        ].join("\n")
      },
      fromSha: "base-sha",
      toSha: "head-sha",
      worktreePath: "/tmp/worktree",
    })

    expect(calls).toEqual([
      {
        command: "git diff --no-ext-diff --unified=3 'base-sha'...'head-sha'",
        cwd: "/tmp/worktree",
      },
    ])
    expect(targets.get("src/app.ts")?.has(2)).toBe(true)
  })

  test("fetches missing pull request refs before building inline targets", async () => {
    const calls: { command: string; cwd?: string }[] = []
    const localCommits = new Set(["head-sha"])
    const targets = await inlineCommentTargetsForDiff({
      ensure: {
        fromSource: "base",
        meta: pullRequestMeta,
        repository,
        toSource: "head",
      },
      exec: async (command, options) => {
        calls.push({ command, cwd: options?.cwd })

        if (command.startsWith("git cat-file -e")) {
          const sha = /'([^']+)\^\{commit\}'/.exec(command)?.[1]
          if (sha && localCommits.has(sha)) return ""

          throw new Error("missing commit")
        }
        if (command.startsWith("git fetch --no-tags")) {
          localCommits.add("base-sha")

          return ""
        }

        return [
          "diff --git a/src/app.ts b/src/app.ts",
          "--- a/src/app.ts",
          "+++ b/src/app.ts",
          "@@ -1 +1,2 @@",
          " existing",
          "+added",
        ].join("\n")
      },
      fromSha: "base-sha",
      toSha: "head-sha",
      worktreePath: "/tmp/worktree",
    })

    expect(calls).toEqual([
      {
        command: "git cat-file -e 'base-sha^{commit}'",
        cwd: "/tmp/worktree",
      },
      {
        command: "git cat-file -e 'head-sha^{commit}'",
        cwd: "/tmp/worktree",
      },
      {
        command:
          "git fetch --no-tags 'https://github.example.com/owner/repo.git' 'refs/heads/main'",
        cwd: "/tmp/worktree",
      },
      {
        command: "git cat-file -e 'base-sha^{commit}'",
        cwd: "/tmp/worktree",
      },
      {
        command: "git diff --no-ext-diff --unified=3 'base-sha'...'head-sha'",
        cwd: "/tmp/worktree",
      },
    ])
    expect(targets.get("src/app.ts")?.has(2)).toBe(true)
  })

  test("reports a clear error when a diff commit stays unavailable", async () => {
    await expect(
      inlineCommentTargetsForDiff({
        ensure: {
          fromSource: "base",
          meta: pullRequestMeta,
          repository,
          toSource: "head",
        },
        exec: async (command) => {
          if (command === "git cat-file -e 'head-sha^{commit}'") return ""
          if (command.startsWith("git fetch --no-tags")) return ""

          throw new Error("missing commit")
        },
        fromSha: "base-sha",
        toSha: "head-sha",
        worktreePath: "/tmp/worktree",
      }),
    ).rejects.toThrow(
      "base commit base-sha is unavailable after fetching base ref main",
    )
  })

  test("builds merge conflict context with an inline target", async () => {
    const commands: { command: string; cwd?: string }[] = []
    const context = await mergeConflictContextForDiff({
      baseSha: "base-sha",
      exec: async (command, options) => {
        commands.push({ command, cwd: options?.cwd })

        if (command.startsWith("git merge-base ")) return "merge-base"

        return [
          "changed in both",
          "  base   100644 1111111111111111111111111111111111111111 src/app.ts",
          "  our    100644 2222222222222222222222222222222222222222 src/app.ts",
          "  their  100644 3333333333333333333333333333333333333333 src/app.ts",
          "@@ -1 +1,5 @@",
          "+<<<<<<< .our",
          " head",
          "+=======",
          "+base",
          "+>>>>>>> .their",
        ].join("\n")
      },
      headSha: "head-sha",
      inlineCommentTargets: new Map([["src/app.ts", new Set([2, 3])]]),
      worktreePath: "/tmp/worktree",
    })

    expect(commands).toEqual([
      {
        command: "git merge-base 'base-sha' 'head-sha'",
        cwd: "/tmp/worktree",
      },
      {
        command: "git merge-tree 'merge-base' 'head-sha' 'base-sha'",
        cwd: "/tmp/worktree",
      },
    ])
    expect(context).toContain("unresolved merge conflicts")
    expect(context).toContain("path: src/app.ts")
    expect(context).toContain("suggestedLine: 2")
    expect(context).toContain("rightSideDiffLines: 2, 3")
  })

  test("restores legacy inline review findings from the posted review body", () => {
    expect(
      reviewOutputFromState({
        author: { login: "bot-a" },
        body: [
          "Inline findings:",
          "- src/orchestrator/merge.ts:42: Preserve skipped findings.",
          "  Fix: Pass existing review findings to the editor.",
        ].join("\n"),
        commit: { oid: "head" },
        state: "CHANGES_REQUESTED",
        submittedAt: "2026-01-01T00:00:00Z",
      }),
    ).toEqual({
      findings: [
        {
          fix: "Pass existing review findings to the editor.",
          issue: "Preserve skipped findings.",
          line: 42,
          path: "src/orchestrator/merge.ts",
        },
      ],
      verdict: "CHANGES_REQUESTED",
    })
  })

  test("restores current inline review findings from review comments", () => {
    expect(
      reviewOutputFromState({
        author: { login: "bot-a" },
        body: "Changes requested: 1 inline comment.",
        comments: [
          {
            body: [
              "**Issue:** Reused reviews should keep inline findings.",
              "",
              "**Fix:** Restore findings from review comments.",
            ].join("\n"),
            line: 42,
            path: "src/orchestrator/review.ts",
            startLine: 40,
          },
        ],
        commit: { oid: "head" },
        state: "CHANGES_REQUESTED",
        submittedAt: "2026-01-01T00:00:00Z",
      }),
    ).toEqual({
      findings: [
        {
          fix: "Restore findings from review comments.",
          issue: "Reused reviews should keep inline findings.",
          line: 42,
          path: "src/orchestrator/review.ts",
          startLine: 40,
        },
      ],
      verdict: "CHANGES_REQUESTED",
    })
  })

  test("ignores legacy body-only requirement findings without inline targets", () => {
    expect(
      reviewOutputFromState({
        author: { login: "bot-a" },
        body: [
          "- Missing issue #128 requirement: Do not bundle broader changes.",
          "  Evidence: The PR includes unrelated test rewrites.",
          "  Fix: Split the unrelated changes into a separate PR.",
        ].join("\n"),
        commit: { oid: "head" },
        state: "CHANGES_REQUESTED",
        submittedAt: "2026-01-01T00:00:00Z",
      }),
    ).toEqual({
      findings: [],
      verdict: "CHANGES_REQUESTED",
    })
  })

  test("rejects unsupported GitHub review states", () => {
    expect(() =>
      reviewOutputFromState({
        author: { login: "bot-a" },
        body: "Looks fine overall.",
        commit: { oid: "head" },
        state: "COMMENTED",
        submittedAt: "2026-01-01T00:00:00Z",
      }),
    ).toThrow("Unsupported GitHub review state: COMMENTED")
  })

  test("detects replies after the reviewer latest thread comment", () => {
    expect(
      hasPendingThreadReply(
        [
          {
            commentId: 1,
            comments: [
              {
                author: "bot-a",
                body: "Please fix this.",
                commentId: 1,
                createdAt: "2026-01-01T00:00:00Z",
              },
              {
                author: "author",
                body: "This is safe because the input is normalized.",
                commentId: 2,
                createdAt: "2026-01-01T00:00:01Z",
              },
            ],
            line: 10,
            path: "src/app.ts",
            threadId: "thread-id",
          },
        ],
        "bot-a",
      ),
    ).toBe(true)
  })

  test("ignores replies already answered by the reviewer", () => {
    expect(
      hasPendingThreadReply(
        [
          {
            commentId: 1,
            comments: [
              {
                author: "bot-a",
                body: "Please fix this.",
                commentId: 1,
                createdAt: "2026-01-01T00:00:00Z",
              },
              {
                author: "author",
                body: "Why?",
                commentId: 2,
                createdAt: "2026-01-01T00:00:01Z",
              },
              {
                author: "bot-a",
                body: "Because it can throw.",
                commentId: 3,
                createdAt: "2026-01-01T00:00:02Z",
              },
            ],
            line: 10,
            path: "src/app.ts",
            threadId: "thread-id",
          },
        ],
        "bot-a",
      ),
    ).toBe(false)
  })

  test("includes merge conflict context in reviewer prompts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "magi-review-test-"))
    const commands: string[] = []
    const prompts: string[] = []
    const outputs = [
      JSON.stringify({
        followUps: [],
        newFindings: [],
        resolve: [],
        verdict: "MERGE",
      }),
      JSON.stringify({ findings: [], verdict: "MERGE" }),
      JSON.stringify({ findings: [], verdict: "MERGE" }),
    ]

    try {
      await runReview({
        client: fakeClient(outputs, prompts),
        config: {
          review: { output: "runs", worktree: "worktrees" },
        } satisfies MagiConfig,
        directory,
        dryRun: true,
        exec: fakeExec(commands, {
          diff: [
            "diff --git a/src/app.ts b/src/app.ts",
            "--- a/src/app.ts",
            "+++ b/src/app.ts",
            "@@ -1 +1,2 @@",
            " existing",
            "+added",
          ].join("\n"),
          mergeTree: [
            "changed in both",
            "  base   100644 1111111111111111111111111111111111111111 src/app.ts",
            "  our    100644 2222222222222222222222222222222222222222 src/app.ts",
            "  their  100644 3333333333333333333333333333333333333333 src/app.ts",
            "@@ -1 +1,5 @@",
            "+<<<<<<< .our",
            " existing",
            "+=======",
            "+base",
            "+>>>>>>> .their",
          ].join("\n"),
        }),
        pr: 1,
        repository,
      })

      expect(prompts[0]).toContain("<merge_conflict_context>")
      expect(prompts[0]).toContain("path: src/app.ts")
      expect(prompts[0]).toContain("suggestedLine: 1")
      expect(prompts[0]).toContain("treat unresolved merge conflicts")
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })

  test("reconsiders minority close verdicts from rereview outputs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "magi-review-test-"))
    const commands: string[] = []
    const prompts: string[] = []
    const outputs = [
      JSON.stringify({
        followUps: [],
        newFindings: [],
        reason: "stale review should close",
        resolve: [],
        verdict: "CLOSE",
      }),
      JSON.stringify({ findings: [], verdict: "MERGE" }),
      JSON.stringify({ findings: [], verdict: "MERGE" }),
      JSON.stringify({
        followUps: [],
        newFindings: [],
        resolve: [],
        verdict: "MERGE",
      }),
    ]

    try {
      const result = await runReview({
        client: fakeClient(outputs, prompts),
        config: {
          review: { output: "runs", worktree: "worktrees" },
        } satisfies MagiConfig,
        directory,
        dryRun: true,
        exec: fakeExec(commands),
        pr: 1,
        repository,
      })

      expect(result.outputs["reviewer-1"]).toMatchObject({
        followUps: [],
        newFindings: [],
        resolve: [],
        verdict: "MERGE",
      })
      expect(result.verdict).toBe("MERGE")
      expect(
        prompts.find((prompt) =>
          prompt.includes("CLOSE is not allowed in this reconsideration step"),
        ),
      ).toContain('"newFindings"')
    } finally {
      await rm(directory, { force: true, recursive: true })
    }
  })
})
