import { afterEach, describe, expect, test } from "vitest"
import { mkdtemp, rm as removePath } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  DuplicateIssueCandidate,
  IssueComment,
  IssueMeta,
  RelatedPullRequest,
} from "../github/commands"
import type { Exec, ResolvedRepository } from "../types"
import type { ModelClient } from "./model"
import {
  chooseDuplicateOutput,
  eligibleMentionReplies,
  mentionAllowed,
  resolveIssueKind,
  runTriage,
} from "./triage"

const repository: ResolvedRepository = {
  agents: {
    reviewers: [],
    triage: [
      {
        id: "Melchior",
        index: 0,
        key: "Melchior",
        model: "mock/model",
        permission: "deny",
      },
      {
        id: "Balthasar",
        index: 1,
        key: "Balthasar",
        model: "mock/model",
        permission: "deny",
      },
      {
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
      command.includes("repos/owner/repo/issues/comments/9001") &&
      command.includes("--method PATCH")
    ) {
      return JSON.stringify({
        id: 9001,
        url: "https://github.com/owner/repo/issues/1#issuecomment-9001",
      })
    }
    if (command.startsWith("gh issue close 1")) return "closed"
    if (command.startsWith("gh issue edit 1")) return ""
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
  const result = await runTriage({
    client: model.client,
    config: {},
    directory,
    dryRun: input.dryRun ?? true,
    exec: exec.exec,
    issue: 1,
    repository: input.repository ?? repository,
    runId: "run-test",
  })

  return { ...exec, ...model, result }
}

function vote(vote: string): string {
  return JSON.stringify({ reason: `${vote} reason`, vote })
}

function duplicateVote(vote: string, duplicateOf?: number): string {
  return JSON.stringify({ duplicateOf, reason: `${vote} reason`, vote })
}

function action(action: string): string {
  return JSON.stringify({ action, reason: `${action} reason` })
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
  test("resolves issue kind from configured labels and issue types", () => {
    expect(resolveIssueKind(issue({ type: "Bug" }), repository)).toBe("BUG")
    expect(resolveIssueKind(issue({ type: "Feature" }), repository)).toBe(
      "FEATURE",
    )
    expect(resolveIssueKind(issue({ labels: ["bug"] }), repository)).toBe("BUG")
    expect(
      resolveIssueKind(issue({ labels: ["enhancement"] }), repository),
    ).toBe("FEATURE")
    expect(resolveIssueKind(issue({ type: undefined }), repository)).toBe(
      undefined,
    )
    expect(
      resolveIssueKind(issue({ labels: ["bug"], type: "Feature" }), repository),
    ).toBe(undefined)
  })

  test("skips kind classification when issue type is Bug", async () => {
    const result = await runScenario({
      issue: issue({ type: "Bug" }),
      outputs: [
        vote("YES"),
        vote("YES"),
        vote("YES"),
        action("COMMENT"),
        "Bug accepted comment",
      ],
    })

    expect(result.result.result).toBe("BUG_ACCEPTED")
    expect(
      result.sessionTitles.filter((title) => title.includes("triage bug")),
    ).toHaveLength(3)
    expect(
      result.sessionTitles.some((title) => title.includes("triage kind")),
    ).toBe(false)
  })

  test("skips kind classification when issue type is Feature", async () => {
    const result = await runScenario({
      issue: issue({ type: "Feature" }),
      outputs: [
        vote("YES"),
        vote("YES"),
        vote("YES"),
        action("COMMENT"),
        "Feature accepted comment",
      ],
    })

    expect(result.result.result).toBe("FEATURE_ACCEPTED")
    expect(
      result.sessionTitles.filter((title) => title.includes("triage feature")),
    ).toHaveLength(3)
    expect(
      result.sessionTitles.some((title) => title.includes("triage kind")),
    ).toBe(false)
  })

  test("runs kind classification when issue type and kind labels are absent", async () => {
    const result = await runScenario({
      issue: issue({ type: undefined }),
      outputs: [
        vote("FEATURE"),
        vote("FEATURE"),
        vote("ASK"),
        vote("YES"),
        vote("YES"),
        vote("YES"),
        action("COMMENT"),
        "Feature accepted comment",
      ],
    })

    expect(result.result.result).toBe("FEATURE_ACCEPTED")
    expect(
      result.sessionTitles.filter((title) => title.includes("triage kind")),
    ).toHaveLength(3)
    expect(
      result.sessionTitles.filter((title) => title.includes("triage feature")),
    ).toHaveLength(3)
  })

  test("blocks unsafe issues before model classification", async () => {
    const result = await runScenario({
      issue: issue({ labels: [] }),
      outputs: [],
    })

    expect(result.result.result).toBe("FAILED")
    expect(result.result.report).toContain("missing required labels: triage")
    expect(result.sessionTitles).toEqual([])
  })

  test("detects explicit duplicate candidates before kind classification", async () => {
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

    expect(result.result.result).toBe("DUPLICATE")
    expect(
      result.sessionTitles.filter((title) =>
        title.includes("triage duplicate"),
      ),
    ).toHaveLength(3)
    expect(
      result.sessionTitles.some((title) => title.includes("triage kind")),
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

    expect(result.result.result).toBe("CLEAR_ONLY")
    expect(
      result.sessionTitles.filter((title) =>
        title.includes("triage existing PR"),
      ),
    ).toHaveLength(3)
    expect(
      result.sessionTitles.some((title) => title.includes("triage kind")),
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
        automation: { close: true, clear: ["triage"], pr: false },
      }),
    })

    expect(result.result.result).toBe("BUG_ACCEPTED")
    expect(
      result.commands.some((command) => command.startsWith("gh issue close 1")),
    ).toBe(true)
    expect(
      result.commands.some((command) =>
        command.includes("--remove-label 'triage'"),
      ),
    ).toBe(true)
  })

  test("closes intentionally invalid bug reports when bug vote rejects them", async () => {
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
        automation: { close: true, clear: ["triage"], pr: false },
      }),
    })

    expect(result.result.result).toBe("BUG_REJECTED")
    expect(
      result.commands.some((command) => command.startsWith("gh issue close 1")),
    ).toBe(true)
  })

  test("skips reconsideration when a previous marker has no eligible mentions", async () => {
    const result = await runScenario({
      comments: [
        comment({
          author: "magi-bot",
          body: "Previous comment\n\n<!-- opencode-magi:triage v=1 issue=1 result=BUG_ACCEPTED action=COMMENT checkpoint=10 pr=none processed= -->",
          id: 10,
        }),
      ],
      outputs: [],
    })

    expect(result.result.result).toBe("BUG_ACCEPTED")
    expect(result.sessionTitles).toEqual([])
  })

  test("runs reconsideration for eligible mention replies", async () => {
    const result = await runScenario({
      comments: [
        comment({
          author: "magi-bot",
          body: "Previous comment\n\n<!-- opencode-magi:triage v=1 issue=1 result=FEATURE_ACCEPTED action=COMMENT checkpoint=10 pr=none processed= -->",
          id: 10,
        }),
        comment({
          author: "maintainer",
          authorAssociation: "MEMBER",
          body: "@magi-bot this should be reconsidered",
          id: 11,
        }),
      ],
      outputs: [
        JSON.stringify({
          comments: [
            { classification: "OBJECTION", commentId: 11, reason: "valid" },
          ],
        }),
        vote("FEATURE_REJECTED"),
        vote("FEATURE_REJECTED"),
        vote("ASK"),
        action("COMMENT"),
        "Reconsidered comment",
      ],
    })

    expect(result.result.result).toBe("FEATURE_REJECTED")
    expect(
      result.sessionTitles.some((title) =>
        title.includes("triage comment classification"),
      ),
    ).toBe(true)
    expect(
      result.sessionTitles.filter((title) =>
        title.includes("triage reconsider"),
      ),
    ).toHaveLength(3)
  })

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
