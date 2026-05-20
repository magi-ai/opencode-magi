import { describe, expect, test } from "vitest"
import type { IssueComment } from "../github/commands"
import type { ResolvedRepository } from "../types"
import {
  chooseDuplicateOutput,
  eligibleMentionReplies,
  mentionAllowed,
} from "./triage"

const repository: ResolvedRepository = {
  agents: { reviewers: [] },
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
    account: "magi-bot",
    automation: { clear: ["triage"], close: false, pr: false },
    concurrency: { runs: 3 },
    kind: {
      bug: { label: ["bug"], type: ["Bug"] },
      feature: { label: ["enhancement"], type: ["Feature"] },
    },
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

describe("triage orchestration", () => {
  test("requires majority support for the same duplicate target", () => {
    const result = chooseDuplicateOutput({
      candidateNumbers: [101, 202],
      outputs: [
        { duplicateOf: 101, reason: "same failure", vote: "DUPLICATE" },
        { duplicateOf: 202, reason: "same request", vote: "DUPLICATE" },
        { reason: "not the same", vote: "NOT_DUPLICATE" },
      ],
    })

    expect(result).toBeUndefined()
  })

  test("selects a duplicate target with majority support", () => {
    const result = chooseDuplicateOutput({
      candidateNumbers: [101, 202],
      outputs: [
        { duplicateOf: 101, reason: "same failure", vote: "DUPLICATE" },
        { duplicateOf: 101, reason: "same root cause", vote: "DUPLICATE" },
        { duplicateOf: 202, reason: "similar request", vote: "DUPLICATE" },
      ],
    })

    expect(result?.duplicateOf).toBe(101)
  })

  test("ignores duplicate targets that were not provided as candidates", () => {
    const result = chooseDuplicateOutput({
      candidateNumbers: [101],
      outputs: [
        { duplicateOf: 999, reason: "invalid target", vote: "DUPLICATE" },
        { duplicateOf: 999, reason: "invalid target", vote: "DUPLICATE" },
        { reason: "not the same", vote: "NOT_DUPLICATE" },
      ],
    })

    expect(result).toBeUndefined()
  })

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
