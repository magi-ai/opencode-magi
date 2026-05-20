import type { ResolvedRepository } from "../types"
import { describe, expect, test } from "vitest"
import {
  buildReviewContextSnapshot,
  collectIssueRelationships,
  renderReviewContext,
  type ReviewContextSnapshot,
} from "./review-context"

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
    approvalPolicy: "majority",
    auto: true,
    deleteBranch: true,
    maxThreadResolutionCycles: 5,
    mergeQueue: false,
    method: "squash",
  },
  prompts: {},
  safety: { allowAuthors: [], blockedPaths: [], requiredLabels: [] },
}

describe("review context", () => {
  test("applies default comment limits when building a snapshot", async () => {
    const comments = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        author: { login: "commenter" },
        body: `comment ${index + 1}`,
        createdAt: `2026-01-01T00:00:${String(index).padStart(2, "0")}Z`,
        databaseId: index + 1,
        url: `https://github.com/owner/repo/issues/47#issuecomment-${index + 1}`,
      }))

    const snapshot = await buildReviewContextSnapshot({
      exec: async (command) => {
        if (command.includes("closingIssuesReferences")) {
          return JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  closingIssuesReferences: {
                    nodes: [
                      {
                        author: { login: "author" },
                        body: "Issue body",
                        labels: { nodes: [] },
                        number: 47,
                        state: "OPEN",
                        title: "Issue title",
                        url: "https://github.com/owner/repo/issues/47",
                      },
                    ],
                  },
                },
              },
            },
          })
        }
        if (command.includes("reviewThreads")) {
          return JSON.stringify({
            data: {
              repository: {
                pullRequest: { reviewThreads: { nodes: [] } },
              },
            },
          })
        }
        if (command.includes("files(first:")) {
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
                  labels: { nodes: [] },
                },
              },
            },
          })
        }
        if (command.includes("pullRequest(number: $pr) { comments")) {
          return JSON.stringify({
            data: {
              repository: {
                pullRequest: { comments: { nodes: comments(21) } },
              },
            },
          })
        }
        if (command.includes("issue(number: $issue) { comments")) {
          return JSON.stringify({
            data: {
              repository: {
                issue: {
                  comments: {
                    nodes: comments(25),
                  },
                },
              },
            },
          })
        }

        throw new Error(`unexpected command: ${command}`)
      },
      pr: {
        author: { login: "author" },
        baseRefName: "main",
        baseRefOid: "base",
        body: "Closes #47",
        headRefName: "feature",
        headRefOid: "head",
        isDraft: false,
        number: 52,
        state: "OPEN",
        title: "Feature",
        url: "https://github.com/owner/repo/pull/52",
      },
      repository,
    })

    expect(snapshot.pullRequest.comments).toHaveLength(20)
    expect(snapshot.pullRequest.comments[0].id).toBe(2)
    expect(snapshot.closingIssues[0].comments).toHaveLength(20)
    expect(snapshot.closingIssues[0].comments[0].id).toBe(6)
  })

  test("detects closing and referenced issue relationships", () => {
    const relationships = collectIssueRelationships({
      closingIssues: [
        {
          author: "author",
          body: "body",
          labels: [],
          number: 47,
          state: "OPEN",
          title: "Closing issue",
          url: "https://github.com/owner/repo/issues/47",
        },
      ],
      pr: {
        baseRefName: "main",
        baseRefOid: "base",
        body: "Closes #47\nRelated #58\nSee https://github.com/owner/repo/issues/59",
        headRefName: "feature",
        headRefOid: "head",
        isDraft: false,
        number: 52,
        title: "Fix review context",
        url: "https://github.com/owner/repo/pull/52",
      },
      prComments: [
        {
          author: "reviewer",
          body: "Also fixes #60",
          createdAt: "2026-01-01T00:00:00Z",
          id: 1,
          url: "https://github.com/owner/repo/pull/52#issuecomment-1",
        },
      ],
      repository,
      reviewThreads: [],
    })

    expect(relationships).toEqual([
      {
        number: 47,
        relationship: "closing",
        sources: [
          "GitHub closingIssuesReferences",
          'PR body "#47"',
          'PR body "Closes #47"',
        ],
      },
      { number: 58, relationship: "referenced", sources: ['PR body "#58"'] },
      {
        number: 59,
        relationship: "referenced",
        sources: ['PR body "https://github.com/owner/repo/issues/59"'],
      },
      {
        number: 60,
        relationship: "closing",
        sources: ['PR comment 1 "#60"', 'PR comment 1 "fixes #60"'],
      },
    ])
  })

  test("renders bounded PR, issue, and review discussion context", () => {
    const longBody = "x".repeat(4001)
    const snapshot: ReviewContextSnapshot = {
      closingIssues: [
        {
          author: "author",
          body: "Acceptance criteria",
          comments: [
            {
              author: "commenter",
              body: longBody,
              createdAt: "2026-01-01T00:00:00Z",
              id: 10,
              truncated: true,
            },
          ],
          number: 47,
          relationship: "closing",
          source: 'PR body "Closes #47"',
          state: "OPEN",
          title: "Add feature",
          url: "https://github.com/owner/repo/issues/47",
        },
      ],
      pullRequest: {
        author: "author",
        baseRef: "main",
        baseSha: "base",
        body: "Closes #47",
        changedFiles: ["src/app.ts"],
        comments: [],
        headRef: "feature",
        headSha: "head",
        number: 52,
        relationship: "target",
        source: "/magi:review input",
        state: "OPEN",
        title: "Implement feature",
        url: "https://github.com/owner/repo/pull/52",
      },
      referencedIssues: [],
      reviewDiscussion: {
        prComments: [],
        reviewThreads: [
          {
            commentId: 1,
            comments: [
              {
                author: "bot",
                body: "Please fix this.",
                commentId: 1,
                createdAt: "2026-01-01T00:00:00Z",
              },
            ],
            isResolved: false,
            line: 10,
            path: "src/app.ts",
            threadId: "thread-id",
          },
        ],
      },
    }
    const rendered = renderReviewContext(snapshot)

    expect(rendered).toContain("<pull_request_context>")
    expect(rendered).toContain("<closing_issues>")
    expect(rendered).toContain("changedFiles:\n- src/app.ts")
    expect(rendered).toContain("[truncated]")
    expect(rendered).toContain("threadId: thread-id")
  })
})
