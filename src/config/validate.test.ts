import type { MagiConfig } from "../types"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import { validateConfig } from "./validate"

const config: MagiConfig = {
  agents: {
    reviewers: [
      {
        model: "anthropic/claude",
        account: "bot-a",
        options: { thinking: { type: "enabled", budgetTokens: 16000 } },
      },
      { id: "security", model: "anthropic/claude", account: "bot-b" },
      { id: "compat", model: "openai/gpt", account: "bot-c" },
    ],
    editor: {
      model: "openai/gpt",
      account: "bot-c",
      author: { email: "bot-c@example.com", name: "Bot C" },
    },
  },
  github: { owner: "owner", repo: "repo" },
  language: "en",
  prompts: { review: "global-review.md" },
}
const reviewers = config.agents.reviewers ?? []

describe("validateConfig", () => {
  test("accepts valid odd reviewer config", async () => {
    const result = await validateConfig(config)

    expect(result.ok).toBe(true)
    expect(result.errors).toEqual([])
  })

  test("allows missing editor unless merge validation requires it", async () => {
    const withoutEditor: MagiConfig = {
      ...config,
      agents: { reviewers },
    }

    await expect(validateConfig(withoutEditor)).resolves.toMatchObject({
      ok: true,
    })
    await expect(
      validateConfig(withoutEditor, { requireEditor: true }),
    ).resolves.toMatchObject({
      errors: ["agents.editor is required"],
      ok: false,
    })
  })

  test("requires editor author when editor is configured", async () => {
    const result = await validateConfig({
      ...config,
      agents: {
        ...config.agents,
        editor: {
          model: "openai/gpt",
          account: "bot-c",
        } as MagiConfig["agents"]["editor"],
      },
    })

    expect(result.ok).toBe(false)
    expect(result.errors).toContain("agents.editor.author.name is required")
    expect(result.errors).toContain("agents.editor.author.email is required")
  })

  test("allows global config without github", async () => {
    const globalConfig: MagiConfig = {
      agents: { reviewers },
    }

    await expect(
      validateConfig(globalConfig, { requireGithub: false }),
    ).resolves.toMatchObject({ ok: true })
  })

  test("rejects even reviewer config", async () => {
    const result = await validateConfig({
      ...config,
      agents: {
        ...config.agents,
        reviewers: [...reviewers, { account: "bot-d", model: "google/gemini" }],
      },
    })

    expect(result.ok).toBe(false)
    expect(result.errors).toContain(
      "agents.reviewers must contain an odd number of reviewers",
    )
  })

  test("rejects invalid concurrency config", async () => {
    const result = await validateConfig({
      ...config,
      concurrency: { runs: 0, reviewers: -1 },
    })

    expect(result.ok).toBe(false)
    expect(result.errors).toContain(
      "concurrency.runs must be a positive integer",
    )
    expect(result.errors).toContain(
      "concurrency.reviewers must be a positive integer",
    )
  })

  test("rejects invalid automation and approval policy config", async () => {
    const result = await validateConfig({
      ...config,
      automation: {
        close: "yes",
        merge: "no",
      } as unknown as MagiConfig["automation"],
      merge: { approvalPolicy: "all" as "majority" },
    })

    expect(result.ok).toBe(false)
    expect(result.errors).toContain("automation.close must be a boolean")
    expect(result.errors).toContain("automation.merge must be a boolean")
    expect(result.errors).toContain(
      "merge.approvalPolicy must be majority or unanimous",
    )
  })

  test("rejects invalid thread resolution cycle config", async () => {
    const result = await validateConfig({
      ...config,
      merge: { maxThreadResolutionCycles: -1 },
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
      checks: { retryFailedJobs: -1 },
    })

    expect(result.ok).toBe(false)
    expect(result.errors).toContain(
      "checks.retryFailedJobs must be a non-negative integer",
    )
  })

  test("rejects unknown config keys", async () => {
    const result = await validateConfig({
      ...config,
      extra: true,
      github: { ...config.github, unknown: true },
      merge: { ...config.merge, queue: true },
    } as unknown as MagiConfig)

    expect(result.ok).toBe(false)
    expect(result.errors).toContain("config.extra is not supported")
    expect(result.errors).toContain("github.unknown is not supported")
    expect(result.errors).toContain("merge.queue is not supported")
  })

  test("rejects invalid worktree dirs config", async () => {
    const result = await validateConfig({
      ...config,
      worktree: {
        dir: ".magi/worktrees",
        dirs: { pr: 1 },
      } as unknown as MagiConfig["worktree"],
    })

    expect(result.ok).toBe(false)
    expect(result.errors).toContain("worktree.dir is not supported")
    expect(result.errors).toContain("worktree.dirs.pr must be a string")
  })

  test("checks prompt file paths when directory is provided", async () => {
    const dir = await mkdtemp(join(tmpdir(), "magi-validate-"))
    await writeFile(join(dir, "review.txt"), "Review guide")

    const result = await validateConfig(
      {
        ...config,
        prompts: {
          editGuidelines: "missing.txt",
          reviewGuidelines: "review.txt",
        },
      },
      { directory: dir },
    )

    expect(result.ok).toBe(false)
    expect(result.errors).toContain(
      "prompts.editGuidelines file is not readable: missing.txt",
    )
    expect(result.errors).not.toContain(
      "prompts.reviewGuidelines file is not readable: review.txt",
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
      checks: { exclude: ["Test", 1] as string[] },
    })

    expect(result.ok).toBe(false)
    expect(result.errors).toContain("checks.exclude[1] must be a string")
  })

  test("rejects invalid safety config", async () => {
    const result = await validateConfig({
      ...config,
      safety: {
        allowAuthors: ["bot-a", 1],
        blockedPaths: [".github/**"],
        maxChangedFiles: -1,
        requiredLabels: ["magi-ok"],
      } as unknown as MagiConfig["safety"],
    })

    expect(result.ok).toBe(false)
    expect(result.errors).toContain("safety.allowAuthors[1] must be a string")
    expect(result.errors).toContain(
      "safety.maxChangedFiles must be a non-negative integer",
    )
  })

  test("rejects non-object model options", async () => {
    const result = await validateConfig({
      ...config,
      agents: {
        ...config.agents,
        reviewers: [
          { account: "bot-a", model: "openai/gpt", options: "high" },
          { account: "bot-b", model: "openai/gpt" },
          { account: "bot-c", model: "openai/gpt" },
        ] as MagiConfig["agents"]["reviewers"],
      },
    })

    expect(result.ok).toBe(false)
    expect(result.errors).toContain(
      "agents.reviewers[0].options must be an object",
    )
  })

  test("accepts valid permission config", async () => {
    const result = await validateConfig({
      ...config,
      agents: {
        ...config.agents,
        permissions: { bash: { "*": "deny", "git status*": "allow" } },
        reviewers: [
          {
            ...(reviewers[0] as NonNullable<(typeof reviewers)[number]>),
            permission: { webfetch: "allow" },
          },
          ...reviewers.slice(1),
        ],
        editor: config.agents.editor
          ? { ...config.agents.editor, permission: { edit: "allow" } }
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
        permissions: { bash: { "git status*": "yes" } },
        reviewers: [
          {
            ...(reviewers[0] as NonNullable<(typeof reviewers)[number]>),
            permission: { webfetch: "maybe" },
          },
          ...reviewers.slice(1),
        ],
      } as unknown as MagiConfig["agents"],
    })

    expect(result.ok).toBe(false)
    expect(result.errors).toContain(
      "agents.permissions.bash.git status* must be allow, ask, or deny",
    )
    expect(result.errors).toContain(
      "agents.reviewers[0].permission.webfetch must be allow, ask, deny, or an object",
    )
  })

  test("rejects model IDs without provider", async () => {
    const result = await validateConfig({
      ...config,
      agents: {
        ...config.agents,
        reviewers: [
          { account: "bot-a", model: "gpt" },
          { account: "bot-b", model: "openai/gpt" },
          { account: "bot-c", model: "openai/gpt" },
        ],
      },
    })

    expect(result.ok).toBe(false)
    expect(result.errors).toContain(
      "agents.reviewers[0].model must be a full OpenCode model ID in provider/model form",
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
      "agents.reviewers[2].model uses unknown OpenCode model: openai/gpt",
    )
    expect(result.errors).toContain(
      "agents.editor.model uses unknown OpenCode model: openai/gpt",
    )
  })

  test("checks gh auth when requested", async () => {
    const result = await validateConfig(config, {
      checkAuth: true,
      exec: async (command) => {
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
      exec: async (command) => {
        if (command.startsWith("gh auth token")) {
          const account = command.match(/--user "([^"]+)"/)?.[1]
          return `${account}-token`
        }

        if (command.includes("gh api repos/owner/repo")) {
          if (command.startsWith('GH_TOKEN="bot-a-token"')) {
            return JSON.stringify({ pull: false, push: false })
          }

          if (command.startsWith('GH_TOKEN="bot-c-token"')) {
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
})
