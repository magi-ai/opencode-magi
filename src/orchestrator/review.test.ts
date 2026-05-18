import type { PullRequestReview } from "../github/commands"
import { describe, expect, test } from "vitest"
import {
  hasPendingThreadReply,
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

describe("review flow", () => {
  test("uses initial review when no configured account reviewed", () => {
    const mode = resolveReviewMode([], accounts, {
      headSha: "head",
      type: "head",
    })

    expect(mode.type).toBe("active")
    if (mode.type !== "active") throw new Error("expected active mode")
    expect([...mode.assignments.values()].map((item) => item.type)).toEqual([
      "initial",
      "initial",
      "initial",
    ])
  })

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

  test("uses rereview when a reviewed head account has a pending thread reply", () => {
    const mode = resolveReviewMode(
      [
        review("bot-a", "head", "2026-01-01T00:00:00Z"),
        review("bot-b", "head", "2026-01-01T00:00:01Z"),
        review("bot-c", "head", "2026-01-01T00:00:02Z"),
      ],
      accounts,
      { headSha: "head", type: "head" },
      new Set(["bot-b"]),
    )

    expect(mode.type).toBe("active")
    if (mode.type !== "active") throw new Error("expected active mode")
    expect([...mode.assignments.values()].map((item) => item.type)).toEqual([
      "skip",
      "rereview",
      "skip",
    ])
  })

  test("uses rereview when configured accounts reviewed an older commit", () => {
    const mode = resolveReviewMode(
      [
        review("bot-a", "old", "2026-01-01T00:00:00Z"),
        review("bot-b", "old", "2026-01-01T00:00:01Z"),
        review("bot-c", "old", "2026-01-01T00:00:02Z"),
      ],
      accounts,
      { headSha: "head", type: "head" },
    )

    expect(mode.type).toBe("active")
    if (mode.type !== "active") throw new Error("expected active mode")
    expect([...mode.assignments.values()].map((item) => item.type)).toEqual([
      "rereview",
      "rereview",
      "rereview",
    ])
  })

  test("skips reviewed head accounts and reviews missing accounts", () => {
    const mode = resolveReviewMode(
      [review("bot-a", "head", "2026-01-01T00:00:00Z")],
      accounts,
      { headSha: "head", type: "head" },
    )

    expect(mode.type).toBe("active")
    if (mode.type !== "active") throw new Error("expected active mode")
    expect([...mode.assignments.values()].map((item) => item.type)).toEqual([
      "skip",
      "initial",
      "initial",
    ])
  })

  test("mixes skip, rereview, and initial assignments", () => {
    const mode = resolveReviewMode(
      [
        review("bot-a", "head", "2026-01-01T00:00:00Z"),
        review("bot-b", "old", "2026-01-01T00:00:01Z"),
      ],
      accounts,
      { headSha: "head", type: "head" },
    )

    expect(mode.type).toBe("active")
    if (mode.type !== "active") throw new Error("expected active mode")
    expect([...mode.assignments.values()].map((item) => item.type)).toEqual([
      "skip",
      "rereview",
      "initial",
    ])
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
