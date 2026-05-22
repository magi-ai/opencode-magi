import type { MagiConfig } from "../types"
import { describe, expect, test } from "vitest"
import { resolveRepository, reviewerKey } from "./resolve"

const config: MagiConfig = {
  agents: {},
  github: { owner: "owner", repo: "repo" },
  language: "en",
  review: {
    agents: [
      {
        model: "anthropic/claude",
        account: "bot-a",
        options: { thinking: { type: "enabled", budgetTokens: 16000 } },
      },
      { id: "security", model: "anthropic/claude", account: "bot-b" },
      { id: "compat", model: "openai/gpt", account: "bot-c" },
    ],
    prompts: { review: "global-review.md" },
  },
  merge: {
    editor: {
      model: "openai/gpt",
      account: "bot-c",
      author: { email: "bot-c@example.com", name: "Bot C" },
    },
  },
}
const reviewers = config.review?.agents ?? []

describe("resolveRepository", () => {
  test("uses index reviewer keys unless id is configured", () => {
    expect(reviewerKey({}, 0)).toBe("reviewer-1")
    expect(reviewerKey({ id: "security" }, 1)).toBe("security")
  })

  test("resolves repository defaults", () => {
    const repo = resolveRepository(config)

    expect(repo.alias).toBe("repo")
    expect(repo.github.apiRetryAttempts).toBe(3)
    expect(repo.github.host).toBe("github.com")
    expect(repo.agents.reviewers.map((reviewer) => reviewer.key)).toEqual([
      "reviewer-1",
      "security",
      "compat",
    ])
    expect(repo.merge.method).toBe("squash")
    expect(repo.merge.approvalPolicy).toBe("majority")
    expect(repo.merge.mergeQueue).toBe(false)
    expect(repo.merge.maxThreadResolutionCycles).toBe(5)
    expect(repo.automation).toEqual({ close: false, merge: true })
    expect(repo.reviewAutomation).toEqual({ close: false, merge: true })
    expect(repo.concurrency).toEqual({ runs: 3, reviewers: 3 })
    expect(repo.checks.exclude).toEqual([])
    expect(repo.checks.waitAfterEdit).toBe(true)
    expect(repo.checks.retryFailedJobs).toBe(3)
    expect(repo.language).toBe("en")
    expect(repo.prompts.review).toBe("global-review.md")
  })

  test("resolves default triage categories", () => {
    const repo = resolveRepository({
      github: { owner: "owner", repo: "repo" },
      triage: { agents: [] },
    })

    expect(repo.triage?.categories).toEqual([
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
    ])
    expect(repo.triage?.automation).toEqual({
      clear: ["triage"],
      close: false,
      create: false,
      merge: false,
      review: false,
    })
  })

  test("resolves triage review and merge automation", () => {
    const repo = resolveRepository({
      github: { owner: "owner", repo: "repo" },
      triage: {
        agents: [],
        automation: { create: true, merge: true, review: true },
      },
    })

    expect(repo.triage?.automation).toMatchObject({
      create: true,
      merge: true,
      review: true,
    })
  })

  test("defaults triage category labels and types", () => {
    const repo = resolveRepository({
      github: { owner: "owner", repo: "repo" },
      triage: {
        agents: [],
        categories: [{ id: "question" }],
      },
    })

    expect(repo.triage?.categories).toEqual([
      { id: "question", labels: [], types: [] },
    ])
  })

  test("respects disabled review merge automation", () => {
    const repo = resolveRepository({
      ...config,
      review: {
        ...config.review,
        automation: { merge: false },
      },
    })

    expect(repo.reviewAutomation).toEqual({ close: false, merge: false })
  })

  test("resolves representative default permissions for reviewers and editor", () => {
    const repo = resolveRepository(config)

    const reviewerPermission = repo.agents.reviewers[0].permission
    expect(reviewerPermission).toMatchObject({
      edit: "deny",
      read: "allow",
      bash: {
        "*": "deny",
        "git status*": "allow",
      },
    })

    expect(repo.agents.editor?.permission).toMatchObject({
      edit: "allow",
      bash: {
        "git add*": "allow",
        "git commit*": "allow",
        "pnpm *": "allow",
      },
    })
  })

  test("resolves representative package manager permissions for triage creators", () => {
    const repo = resolveRepository({
      ...config,
      triage: {
        creator: {
          model: "openai/gpt",
          author: { email: "bot-c@example.com", name: "Bot C" },
        },
      },
    })

    expect(repo.agents.triageCreator?.permission).toMatchObject({
      edit: "allow",
      bash: {
        "corepack *": "allow",
        "pnpm *": "allow",
      },
    })
  })

  test("merges common and per-agent permission overrides", () => {
    const repo = resolveRepository({
      ...config,
      agents: {
        ...config.agents,
        permissions: {
          bash: { "gh pr view*": "allow" },
          webfetch: "allow",
        },
      },
      review: {
        ...config.review,
        agents: [
          {
            ...(reviewers[0] as NonNullable<(typeof reviewers)[number]>),
            permissions: { bash: { "git push*": "deny" }, webfetch: "deny" },
          },
          ...reviewers.slice(1),
        ],
      },
    })

    expect(repo.agents.reviewers[0].permission).toMatchObject({
      bash: {
        "*": "deny",
        "gh pr view*": "allow",
        "git push*": "deny",
        "git status*": "allow",
      },
      webfetch: "deny",
    })
    expect(repo.agents.reviewers[1].permission).toMatchObject({
      bash: { "gh pr view*": "allow" },
      webfetch: "allow",
    })
  })
})
