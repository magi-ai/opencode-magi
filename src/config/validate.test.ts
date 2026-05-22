import type { MagiConfig, PermissionConfig } from "../types"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import { resolveRepository } from "./resolve"
import { validateConfig } from "./validate"

const config: MagiConfig = {
  agents: {
    permissions: { bash: { "git status*": "allow" } },
  },
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
const triageAgents = [
  { account: "triage-a", model: "openai/gpt" },
  { account: "triage-b", model: "anthropic/claude" },
  { account: "triage-c", model: "google/gemini" },
]

describe("validateConfig", () => {
  test("accepts valid odd reviewer config", async () => {
    const result = await validateConfig(config)

    expect(result.ok).toBe(true)
    expect(result.errors).toEqual([])
  })

  test("expands agent refs before validation and resolution", async () => {
    const refConfig = {
      agents: {
        refs: {
          shared: {
            model: "openai/gpt",
            options: { reasoningEffort: "high" },
            persona: "Shared persona",
          },
          editor: {
            model: "openai/gpt",
            account: "editor-bot",
            author: { email: "editor@example.com", name: "Editor Bot" },
          },
        },
      },
      github: { owner: "owner", repo: "repo" },
      review: {
        agents: [
          { ref: "shared", id: "alpha", account: "bot-a" },
          {
            ref: "shared",
            id: "beta",
            account: "bot-b",
            options: { reasoningEffort: "low" },
          },
          { ref: "shared", id: "gamma", account: "bot-c" },
        ],
      },
      merge: {
        editor: { ref: "editor", persona: "Edit carefully" },
      },
      triage: {
        agents: [
          { ref: "shared", account: "triage-a", id: "first" },
          { ref: "shared", account: "triage-b", id: "second" },
          { ref: "shared", account: "triage-c", id: "third" },
        ],
        creator: { ref: "editor", account: "creator-bot" },
      },
    } as unknown as MagiConfig

    const result = await validateConfig(refConfig, {
      requireTriage: true,
    })
    const repository = resolveRepository(refConfig)

    expect(result).toMatchObject({ errors: [], ok: true })
    expect(refConfig.agents?.refs).toBeUndefined()
    expect(refConfig.review?.agents?.[0]).toEqual({
      account: "bot-a",
      id: "alpha",
      model: "openai/gpt",
      options: { reasoningEffort: "high" },
      persona: "Shared persona",
    })
    expect(refConfig.review?.agents?.[1].options).toEqual({
      reasoningEffort: "low",
    })
    expect(refConfig.review?.agents?.[0]).not.toHaveProperty("ref")
    expect(repository.agents.reviewers[0]).toMatchObject({
      account: "bot-a",
      key: "alpha",
      model: "openai/gpt",
    })
    expect(repository.agents.editor).toMatchObject({
      account: "editor-bot",
      model: "openai/gpt",
      persona: "Edit carefully",
    })
    expect(repository.agents.triageCreator).toMatchObject({
      account: "creator-bot",
      model: "openai/gpt",
    })
  })

  test("reports clear errors for invalid agent ref uses", async () => {
    const refConfig = {
      agents: { refs: { shared: { model: "openai/gpt" } } },
      github: { owner: "owner", repo: "repo" },
      review: {
        agents: [
          { ref: "missing", account: "bot-a" },
          { ref: 1, account: "bot-b" },
          { ref: "shared", account: "bot-c" },
        ],
      },
    } as unknown as MagiConfig

    const result = await validateConfig(refConfig)

    expect(result.ok).toBe(false)
    expect(result.errors).toContain(
      "review.agents[0].ref references unknown agents.refs preset: missing",
    )
    expect(result.errors).toContain("review.agents[1].ref must be a string")
    expect(refConfig.agents?.refs).toBeUndefined()
    expect(refConfig.review?.agents?.[0]).not.toHaveProperty("ref")
  })

  test("does not validate unused agent refs", async () => {
    const refConfig = {
      agents: {
        refs: {
          unused: { author: "invalid", unknown: true },
        },
      },
      github: { owner: "owner", repo: "repo" },
      review: {
        agents: [
          { model: "openai/gpt", account: "bot-a" },
          { model: "openai/gpt", account: "bot-b" },
          { model: "openai/gpt", account: "bot-c" },
        ],
      },
    } as unknown as MagiConfig

    const result = await validateConfig(refConfig)

    expect(result).toMatchObject({ errors: [], ok: true })
    expect(refConfig.agents?.refs).toBeUndefined()
  })

  test("applies role-specific validation after agent ref expansion", async () => {
    const refConfig = {
      agents: {
        refs: {
          creator: {
            model: "openai/gpt",
            author: { email: "creator@example.com", name: "Creator Bot" },
          },
        },
      },
      github: { owner: "owner", repo: "repo" },
      review: {
        agents: [
          { ref: "creator", account: "bot-a" },
          { model: "openai/gpt", account: "bot-b" },
          { model: "openai/gpt", account: "bot-c" },
        ],
      },
    } as unknown as MagiConfig

    const result = await validateConfig(refConfig)

    expect(result.ok).toBe(false)
    expect(result.errors).toContain("review.agents[0].author is not supported")
  })

  test("allows missing editor unless merge validation requires it", async () => {
    const withoutEditor: MagiConfig = {
      ...config,
      merge: undefined,
    }

    await expect(validateConfig(withoutEditor)).resolves.toMatchObject({
      ok: true,
    })
    await expect(
      validateConfig(withoutEditor, { requireEditor: true }),
    ).resolves.toMatchObject({
      errors: ["merge.editor is required"],
      ok: false,
    })
  })

  test("requires editor author when editor is configured", async () => {
    const result = await validateConfig({
      ...config,
      merge: {
        ...config.merge,
        editor: {
          model: "openai/gpt",
          account: "bot-c",
        } as NonNullable<MagiConfig["merge"]>["editor"],
      },
    })

    expect(result.ok).toBe(false)
    expect(result.errors).toContain("merge.editor.author.name is required")
    expect(result.errors).toContain("merge.editor.author.email is required")
  })

  test("allows global config without github", async () => {
    const globalConfig: MagiConfig = {
      review: { agents: reviewers },
    }

    await expect(
      validateConfig(globalConfig, { requireGithub: false }),
    ).resolves.toMatchObject({ ok: true })
  })

  test("accepts triage-only config when required", async () => {
    const result = await validateConfig(
      {
        github: { owner: "owner", repo: "repo" },
        triage: {
          agents: [
            { account: "triage-a", model: "openai/gpt" },
            { account: "triage-b", id: "product", model: "anthropic/claude" },
            { account: "triage-c", id: "maintainer", model: "google/gemini" },
          ],
        },
      },
      { requireReview: false, requireTriage: true },
    )

    expect(result).toMatchObject({ errors: [], ok: true })
  })

  test("validates triage reporter against resolved triage agent keys", async () => {
    const result = await validateConfig(
      {
        github: { owner: "owner", repo: "repo" },
        triage: {
          agents: [
            { account: "triage-a", model: "openai/gpt" },
            { account: "triage-b", id: "product", model: "anthropic/claude" },
            { account: "triage-c", model: "google/gemini" },
          ],
          reporter: "product",
        },
      },
      { requireReview: false, requireTriage: true },
    )
    const generated = await validateConfig(
      {
        github: { owner: "owner", repo: "repo" },
        triage: { agents: triageAgents, reporter: "triage-1" },
      },
      { requireReview: false, requireTriage: true },
    )
    const invalid = await validateConfig(
      {
        github: { owner: "owner", repo: "repo" },
        triage: { agents: triageAgents, reporter: "missing" },
      },
      { requireReview: false, requireTriage: true },
    )

    expect(result).toMatchObject({ errors: [], ok: true })
    expect(generated).toMatchObject({ errors: [], ok: true })
    expect(invalid.ok).toBe(false)
    expect(invalid.errors).toContain(
      "triage.reporter must match a triage agent key: missing",
    )
  })

  test("requires triage creator when PR creation automation is enabled", async () => {
    const result = await validateConfig(
      {
        github: { owner: "owner", repo: "repo" },
        triage: {
          agents: triageAgents,
          automation: { create: true },
        },
      },
      { requireReview: false, requireTriage: true },
    )

    expect(result.ok).toBe(false)
    expect(result.errors).toContain(
      "triage.creator is required when triage.automation.create is true",
    )
  })

  test("rejects triage review and merge automation without PR creation", async () => {
    const result = await validateConfig(
      {
        github: { owner: "owner", repo: "repo" },
        triage: {
          agents: triageAgents,
          automation: { merge: true, review: true },
        },
      },
      { requireReview: false, requireTriage: true },
    )

    expect(result.ok).toBe(false)
    expect(result.errors).toContain(
      "triage.automation.review requires triage.automation.create to be true",
    )
    expect(result.errors).toContain(
      "triage.automation.merge requires triage.automation.create to be true",
    )
  })

  test("rejects old triage PR creation automation key", async () => {
    const result = await validateConfig(
      {
        github: { owner: "owner", repo: "repo" },
        triage: {
          agents: triageAgents,
          automation: { pr: true } as unknown as NonNullable<
            MagiConfig["triage"]
          >["automation"],
        },
      },
      { requireReview: false, requireTriage: true },
    )

    expect(result.ok).toBe(false)
    expect(result.errors).toContain("triage.automation.pr is not supported")
  })

  test("rejects old triage PR creation prompt key", async () => {
    const result = await validateConfig(
      {
        github: { owner: "owner", repo: "repo" },
        triage: {
          agents: triageAgents,
          prompts: {
            createPr: "triage-create.md",
          } as unknown as NonNullable<MagiConfig["triage"]>["prompts"],
        },
      },
      { requireReview: false, requireTriage: true },
    )

    expect(result.ok).toBe(false)
    expect(result.errors).toContain("triage.prompts.createPr is not supported")
  })

  test.each([
    {
      name: "missing id",
      categories: [{ labels: ["missing"] }],
      error: "triage.categories[0].id is required",
    },
    {
      name: "invalid id format",
      categories: [{ id: "bad id" }],
      error: "triage.categories[0].id must match /^[A-Za-z0-9_-]+$/",
    },
    {
      name: "non-string label",
      categories: [{ id: "bug", labels: ["bug", 1] as string[] }],
      error: "triage.categories[0].labels[1] must be a string",
    },
    {
      name: "duplicate id",
      categories: [{ id: "bug" }, { id: "bug" }],
      error: "triage.categories[1].id must be unique",
    },
  ])(
    "rejects invalid triage category: $name",
    async ({ categories, error }) => {
      const result = await validateConfig(
        {
          github: { owner: "owner", repo: "repo" },
          triage: {
            agents: triageAgents,
            categories,
          },
        },
        { requireReview: false, requireTriage: true },
      )

      expect(result.ok).toBe(false)
      expect(result.errors).toContain(error)
    },
  )

  test.each([
    { id: "ASK", error: "triage.categories[0].id is reserved: ASK" },
    { id: "none", error: "triage.categories[0].id is reserved: none" },
  ])("rejects reserved triage category id $id", async ({ id, error }) => {
    const result = await validateConfig(
      {
        github: { owner: "owner", repo: "repo" },
        triage: {
          agents: triageAgents,
          categories: [{ id }],
        },
      },
      { requireReview: false, requireTriage: true },
    )

    expect(result.ok).toBe(false)
    expect(result.errors).toContain(error)
  })

  test("rejects non-array triage categories", async () => {
    const result = await validateConfig(
      {
        github: { owner: "owner", repo: "repo" },
        triage: {
          agents: triageAgents,
          categories: {} as NonNullable<MagiConfig["triage"]>["categories"],
        },
      },
      { requireReview: false, requireTriage: true },
    )

    expect(result.ok).toBe(false)
    expect(result.errors).toContain("triage.categories must be an array")
  })

  test("rejects even reviewer config", async () => {
    const result = await validateConfig({
      ...config,
      review: {
        ...config.review,
        agents: [...reviewers, { account: "bot-d", model: "google/gemini" }],
      },
    })

    expect(result.ok).toBe(false)
    expect(result.errors).toContain(
      "review.agents must contain an odd number of reviewers",
    )
  })

  test.each([
    {
      name: "run concurrency",
      concurrency: { runs: 0 },
      error: "review.concurrency.runs must be a positive integer",
    },
    {
      name: "reviewer concurrency",
      concurrency: { reviewers: -1 },
      error: "review.concurrency.reviewers must be a positive integer",
    },
  ])("rejects invalid $name config", async ({ concurrency, error }) => {
    const result = await validateConfig({
      ...config,
      review: { ...config.review, concurrency },
    })

    expect(result.ok).toBe(false)
    expect(result.errors).toContain(error)
  })

  test.each([
    {
      name: "close automation",
      review: {
        ...config.review,
        automation: { close: "yes" } as unknown as NonNullable<
          MagiConfig["review"]
        >["automation"],
      },
      error: "review.automation.close must be a boolean",
    },
    {
      name: "merge automation",
      review: {
        ...config.review,
        automation: { merge: "no" } as unknown as NonNullable<
          MagiConfig["review"]
        >["automation"],
      },
      error: "review.automation.merge must be a boolean",
    },
    {
      name: "approval policy",
      review: {
        ...config.review,
        merge: { approvalPolicy: "all" as "majority" },
      },
      error: "review.merge.approvalPolicy must be majority or unanimous",
    },
  ])("rejects invalid $name config", async ({ review, error }) => {
    const result = await validateConfig({
      ...config,
      review,
    })

    expect(result.ok).toBe(false)
    expect(result.errors).toContain(error)
  })

  test("rejects invalid thread resolution cycle config", async () => {
    const result = await validateConfig({
      ...config,
      merge: { ...config.merge, maxThreadResolutionCycles: -1 },
    })

    expect(result.ok).toBe(false)
    expect(result.errors).toContain(
      "merge.maxThreadResolutionCycles must be a non-negative integer",
    )
  })

  test("rejects invalid clear config", async () => {
    const result = await validateConfig({
      ...config,
      clear: { branch: "yes", output: false } as unknown as MagiConfig["clear"],
    })

    expect(result.ok).toBe(false)
    expect(result.errors).toContain("clear.branch must be a boolean")
  })

  test("rejects invalid checks retry config", async () => {
    const result = await validateConfig({
      ...config,
      review: { ...config.review, checks: { retryFailedJobs: -1 } },
    })

    expect(result.ok).toBe(false)
    expect(result.errors).toContain(
      "review.checks.retryFailedJobs must be a non-negative integer",
    )
  })

  test("rejects unknown config keys", async () => {
    const result = await validateConfig({
      ...config,
      extra: true,
      github: { ...config.github, unknown: true },
      review: { ...config.review, unknown: true },
    } as unknown as MagiConfig)

    expect(result.ok).toBe(false)
    expect(result.errors).toContain("config.extra is not supported")
    expect(result.errors).toContain("github.unknown is not supported")
    expect(result.errors).toContain("review.unknown is not supported")
  })

  test("rejects invalid worktree dirs config", async () => {
    const result = await validateConfig({
      ...config,
      review: {
        ...config.review,
        worktree: 1,
      } as unknown as MagiConfig["review"],
    })

    expect(result.ok).toBe(false)
    expect(result.errors).toContain("review.worktree must be a string")
  })

  test("checks prompt file paths when directory is provided", async () => {
    const dir = await mkdtemp(join(tmpdir(), "magi-validate-"))
    await writeFile(join(dir, "review.txt"), "Review guide")
    await writeFile(join(dir, "create-guide.txt"), "Create guide")

    const result = await validateConfig(
      {
        ...config,
        review: {
          ...config.review,
          prompts: {
            review: "missing.txt",
            reviewGuidelines: "review.txt",
          },
        },
        triage: {
          agents: triageAgents,
          prompts: { createGuidelines: "create-guide.txt" },
        },
      },
      { directory: dir },
    )

    expect(result.ok).toBe(false)
    expect(result.errors).toContain(
      "review.prompts.review file is not readable: missing.txt",
    )
    expect(result.errors).not.toContain(
      "review.prompts.reviewGuidelines file is not readable: review.txt",
    )
    expect(result.errors).not.toContain(
      "triage.prompts.createGuidelines file is not readable: create-guide.txt",
    )
  })

  test("rejects invalid GitHub API retry config", async () => {
    const result = await validateConfig({
      ...config,
      github: { owner: "owner", repo: "repo", apiRetryAttempts: -1 },
    })

    expect(result.ok).toBe(false)
    expect(result.errors).toContain(
      "github.apiRetryAttempts must be a non-negative integer",
    )
  })

  test("rejects invalid checks exclude config", async () => {
    const result = await validateConfig({
      ...config,
      review: {
        ...config.review,
        checks: { exclude: ["Test", 1] as string[] },
      },
    })

    expect(result.ok).toBe(false)
    expect(result.errors).toContain("review.checks.exclude[1] must be a string")
  })

  test.each([
    {
      name: "allow authors",
      safety: {
        allowAuthors: ["bot-a", 1],
        blockedPaths: [".github/**"],
        maxChangedFiles: 1,
        requiredLabels: ["magi-ok"],
      } as unknown as NonNullable<MagiConfig["review"]>["safety"],
      error: "review.safety.allowAuthors[1] must be a string",
    },
    {
      name: "max changed files",
      safety: {
        allowAuthors: ["bot-a"],
        blockedPaths: [".github/**"],
        maxChangedFiles: -1,
        requiredLabels: ["magi-ok"],
      },
      error: "review.safety.maxChangedFiles must be a non-negative integer",
    },
  ])("rejects invalid safety $name config", async ({ safety, error }) => {
    const result = await validateConfig({
      ...config,
      review: {
        ...config.review,
        safety,
      },
    })

    expect(result.ok).toBe(false)
    expect(result.errors).toContain(error)
  })

  test("rejects non-object model options", async () => {
    const result = await validateConfig({
      ...config,
      review: {
        ...config.review,
        agents: [
          { account: "bot-a", model: "openai/gpt", options: "high" },
          { account: "bot-b", model: "openai/gpt" },
          { account: "bot-c", model: "openai/gpt" },
        ] as NonNullable<MagiConfig["review"]>["agents"],
      },
    })

    expect(result.ok).toBe(false)
    expect(result.errors).toContain(
      "review.agents[0].options must be an object",
    )
  })

  test("accepts valid permission config", async () => {
    const result = await validateConfig({
      ...config,
      agents: {
        ...config.agents,
        permissions: { bash: { "*": "deny", "git status*": "allow" } },
      },
      review: {
        ...config.review,
        agents: [
          {
            ...(reviewers[0] as NonNullable<(typeof reviewers)[number]>),
            permissions: { webfetch: "allow" },
          },
          ...reviewers.slice(1),
        ],
      },
      merge: {
        ...config.merge,
        editor: config.merge?.editor
          ? { ...config.merge.editor, permissions: { edit: "allow" } }
          : undefined,
      },
    })

    expect(result.ok).toBe(true)
    expect(result.errors).toEqual([])
  })

  test("rejects invalid permission actions", async () => {
    const result = await validateConfig({
      ...config,
      agents: {
        ...config.agents,
        permissions: {
          bash: { "git status*": "yes" },
        } as unknown as PermissionConfig,
      },
      review: {
        ...config.review,
        agents: [
          {
            ...(reviewers[0] as NonNullable<(typeof reviewers)[number]>),
            permissions: { webfetch: "maybe" },
          },
          ...reviewers.slice(1),
        ],
      } as unknown as MagiConfig["review"],
    })

    expect(result.ok).toBe(false)
    expect(result.errors).toContain(
      "agents.permissions.bash.git status* must be allow, ask, or deny",
    )
    expect(result.errors).toContain(
      "review.agents[0].permissions.webfetch must be allow, ask, deny, or an object",
    )
  })

  test("rejects model IDs without provider", async () => {
    const result = await validateConfig({
      ...config,
      review: {
        ...config.review,
        agents: [
          { account: "bot-a", model: "gpt" },
          { account: "bot-b", model: "openai/gpt" },
          { account: "bot-c", model: "openai/gpt" },
        ],
      },
    })

    expect(result.ok).toBe(false)
    expect(result.errors).toContain(
      "review.agents[0].model must be a full OpenCode model ID in provider/model form",
    )
  })

  test("rejects unknown models when catalog is provided", async () => {
    const result = await validateConfig(config, {
      modelCatalog: {
        anthropic: ["claude"],
        openai: ["gpt-5"],
      },
    })

    expect(result.ok).toBe(false)
    expect(result.errors).toContain(
      "review.agents[2].model uses unknown OpenCode model: openai/gpt",
    )
    expect(result.errors).toContain(
      "merge.editor.model uses unknown OpenCode model: openai/gpt",
    )
  })

  test("checks gh auth when requested", async () => {
    const result = await validateConfig(config, {
      checkAuth: true,
      exec: async (command) => {
        if (command.startsWith("git config --bool --get")) return "true"
        if (command.includes("bot-b")) throw new Error("not logged in")

        return "token"
      },
    })

    expect(result.ok).toBe(false)
    expect(result.errors).toContain(
      "GitHub account is not authenticated: bot-b",
    )
  })

  test("checks repository permissions when auth succeeds", async () => {
    const result = await validateConfig(config, {
      checkAuth: true,
      exec: async (command, options) => {
        if (command.startsWith("git config --bool --get")) return "true"
        if (command.startsWith("gh auth token")) {
          const account = command.match(/--user "([^"]+)"/)?.[1]
          return `${account}-token`
        }

        if (command.includes("gh api repos/owner/repo")) {
          if (options?.env?.GH_TOKEN === "bot-a-token") {
            return JSON.stringify({ pull: false, push: false })
          }

          if (options?.env?.GH_TOKEN === "bot-c-token") {
            return JSON.stringify({ pull: true, push: false })
          }

          return JSON.stringify({ pull: true, push: false })
        }

        throw new Error(`unexpected command: ${command}`)
      },
    })

    expect(result.ok).toBe(false)
    expect(result.errors).toContain(
      "GitHub account cannot read repository for PR review: bot-a",
    )
    expect(result.errors).toContain(
      "GitHub account cannot push to repository for editor operations: bot-c",
    )
  })

  test("warns when repository permissions cannot be validated", async () => {
    const result = await validateConfig(config, {
      checkAuth: true,
      exec: async (command) => {
        if (command.startsWith("git config --bool --get")) return "true"
        if (command.startsWith("gh auth token")) return "token"
        if (command.includes("gh api repos/owner/repo")) {
          throw new Error("api failed")
        }

        throw new Error(`unexpected command: ${command}`)
      },
    })

    expect(result.ok).toBe(true)
    expect(result.warnings).toContain(
      "Could not validate repository permissions for GitHub account: bot-a (api failed)",
    )
  })

  test("does not require worktree config for review-only validation", async () => {
    const result = await validateConfig(config, {
      exec: async (command) => {
        throw new Error(`unexpected command: ${command}`)
      },
    })

    expect(result.ok).toBe(true)
  })

  test("requires worktree config for editor identity configuration", async () => {
    const result = await validateConfig(config, {
      exec: async (command) => {
        if (command.startsWith("git config --bool --get")) return "false"

        throw new Error(`unexpected command: ${command}`)
      },
      requireEditor: true,
    })

    expect(result.ok).toBe(false)
    expect(result.errors).toContain(
      "git config extensions.worktreeConfig must be true when editor or triage PR creator is configured",
    )
  })

  test("requires worktree config for triage PR creator identity configuration", async () => {
    const result = await validateConfig(
      {
        github: { owner: "owner", repo: "repo" },
        triage: {
          agents: triageAgents,
          automation: { create: true },
          creator: {
            account: "creator-bot",
            author: { email: "bot@example.com", name: "Magi Bot" },
            model: "openai/gpt",
          },
        },
      },
      {
        exec: async (command) => {
          if (command.startsWith("git config --bool --get")) {
            throw new Error("unset")
          }

          throw new Error(`unexpected command: ${command}`)
        },
        requireReview: false,
        requireTriage: true,
      },
    )

    expect(result.ok).toBe(false)
    expect(result.errors).toContain(
      "git config extensions.worktreeConfig must be true when editor or triage PR creator is configured",
    )
  })
})
