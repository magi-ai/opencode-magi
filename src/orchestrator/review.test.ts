import type { PullRequestReview } from "../github/commands"
import { describe, expect, test } from "vitest"
import {
  hasPendingThreadReply,
  reviewOutputFromState,
  resolveReviewMode,
  reviewFreshnessTarget,
} from "./review"

const accounts = ["bot-a", "bot-b", "bot-c"]

function review(account: string, commit: string, submittedAt: string) {
  return {
    author: { login: account },
    commit: { oid: commit },
    state: "APPROVED",
    submittedAt,
  } satisfies PullRequestReview
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

describe("review flow", () => {
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
})
