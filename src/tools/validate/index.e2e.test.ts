import type { ToolContext } from "@opencode-ai/plugin"
import type { Magi } from "@/magi"
import type { Exec } from "@/utils"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { test } from "#/fixtures/magi"
import { CONFIG_PATH } from "@/constant"
import { validate } from "."

const mocks = vi.hoisted(() => ({
  getModels: vi.fn(),
}))

vi.mock(import("@/utils"), async (importOriginal) => ({
  ...(await importOriginal()),
  getModels: mocks.getModels,
}))

const globalConfigPath = CONFIG_PATH.GLOBAL

async function writeConfig(path: string, config: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(config))
}

async function executeValidate(magi: Magi): Promise<string> {
  const validateTool = validate(magi).magi_validate

  if (!validateTool) throw new Error("Validate tool not found.")

  const result = await validateTool.execute({}, {
    abort: new AbortController().signal,
    sessionID: "parent-session",
  } as ToolContext)

  if (typeof result !== "string")
    throw new Error("Validate tool did not return a report.")

  return result
}

describe("magi:validate", () => {
  beforeEach(() => {
    mocks.getModels.mockReset().mockResolvedValue(["provider/model"])
  })

  afterEach(() => {
    CONFIG_PATH.GLOBAL = globalConfigPath
  })

  test("passes merged global and project config", async ({
    createMagi,
    temporaryDirectory,
  }) => {
    const projectPath = join(temporaryDirectory, CONFIG_PATH.PROJECT)
    const { magi } = createMagi({ directory: temporaryDirectory })
    const exec = vi.fn<Exec>().mockResolvedValue("token")

    CONFIG_PATH.GLOBAL = join(temporaryDirectory, "global.json")
    magi.exec = exec
    await writeConfig(CONFIG_PATH.GLOBAL, {
      account: "global-account",
      agents: {
        refs: {
          reviewer: { model: ["missing/model", "provider/model"] },
        },
      },
      github: { owner: "global-owner", repo: "global-repo" },
      review: {
        reviewers: [
          { ref: "reviewer" },
          { ref: "reviewer" },
          { ref: "reviewer" },
        ],
      },
    })
    await writeConfig(projectPath, {
      account: "project-account",
      github: { owner: "project-owner", repo: "project-repo" },
    })

    await expect(executeValidate(magi)).resolves.toBe(
      ["Magi config validation: passed", "", "Errors:", "- None"].join("\n"),
    )
    expect(mocks.getModels).toHaveBeenCalledWith(magi.input)
    expect(exec).toHaveBeenCalledWith(
      'gh auth token --user "project-account"',
      undefined,
    )
  })

  test("reports schema and agent group errors", async ({
    createMagi,
    temporaryDirectory,
  }) => {
    const { magi } = createMagi({ directory: temporaryDirectory })
    const exec = vi.fn<Exec>()

    CONFIG_PATH.GLOBAL = join(temporaryDirectory, "global.json")
    magi.exec = exec
    await writeConfig(CONFIG_PATH.GLOBAL, {
      account: "single-account",
      github: {
        owner: "magi-ai",
        repo: "opencode-magi",
        retryApiAttempts: -1,
      },
      review: {
        operator: "missing-reviewer",
        reviewers: [
          { id: "reviewer", model: "provider/model" },
          { id: "reviewer", model: "provider/model" },
          { id: "reviewer-2", model: "provider/model" },
          { id: "reviewer-3", model: "provider/model" },
        ],
      },
      triage: {
        operator: "missing-voter",
        voters: [
          { id: "voter", model: "provider/model" },
          { id: "voter", model: "provider/model" },
          { id: "voter-2", model: "provider/model" },
          { id: "voter-3", model: "provider/model" },
        ],
      },
      unexpected: true,
    })

    await expect(executeValidate(magi)).resolves.toBe(
      [
        "Magi config validation: failed",
        "",
        "Errors:",
        "- schema config: must NOT have additional properties",
        "- schema /github/retryApiAttempts: must be >= 0",
        "- review.reviewers must contain an odd number of agents",
        "- review.reviewers has duplicate id: reviewer",
        "- review.operator must match a configured review reviewer id",
        "- triage.voters must contain an odd number of agents",
        "- triage.voters has duplicate id: voter",
        "- triage.operator must match a configured triage voter id",
      ].join("\n"),
    )
    expect(exec).not.toHaveBeenCalled()
  })

  test("reports an unavailable configured model", async ({
    createMagi,
    temporaryDirectory,
  }) => {
    const { magi } = createMagi({ directory: temporaryDirectory })
    const exec = vi.fn<Exec>()

    CONFIG_PATH.GLOBAL = join(temporaryDirectory, "global.json")
    magi.exec = exec
    await writeConfig(CONFIG_PATH.GLOBAL, {
      account: "single-account",
      github: { owner: "magi-ai", repo: "opencode-magi" },
      review: {
        reviewers: [
          { id: "reviewer-1", model: "missing/model" },
          { id: "reviewer-2", model: "provider/model" },
          { id: "reviewer-3", model: "provider/model" },
        ],
      },
    })

    const report = await executeValidate(magi)

    expect(report).toContain("Magi config validation: failed")
    expect(report).toContain("review.reviewers[0].model is required")
    expect(exec).not.toHaveBeenCalled()
  })

  test("reports failed authentication across multi-agent roles", async ({
    createMagi,
    temporaryDirectory,
  }) => {
    const { magi } = createMagi({ directory: temporaryDirectory })
    const exec = vi.fn<Exec>((command) => {
      if (
        command.includes('"review-account-2"') ||
        command.includes('"creator-account"')
      )
        return Promise.reject(new Error("not logged in"))

      return Promise.resolve("token")
    })

    CONFIG_PATH.GLOBAL = join(temporaryDirectory, "global.json")
    magi.exec = exec
    await writeConfig(CONFIG_PATH.GLOBAL, {
      github: { owner: "magi-ai", repo: "opencode-magi" },
      merge: {
        editor: {
          account: "editor-account",
          author: { email: "editor@example.com", name: "Editor" },
          model: "provider/model",
        },
      },
      mode: "multi",
      review: {
        reviewers: [
          { account: "review-account-1", model: "provider/model" },
          { account: "review-account-2", model: "provider/model" },
          { account: "review-account-3", model: "provider/model" },
        ],
      },
      triage: {
        creator: {
          account: "creator-account",
          author: { email: "creator@example.com", name: "Creator" },
          model: "provider/model",
        },
        voters: [
          { account: "voter-account-1", model: "provider/model" },
          { account: "voter-account-2", model: "provider/model" },
          { account: "voter-account-3", model: "provider/model" },
        ],
      },
    })

    await expect(executeValidate(magi)).resolves.toBe(
      [
        "Magi config validation: failed",
        "",
        "Errors:",
        "- Account is not authenticated: review-account-2",
        "- Account is not authenticated: creator-account",
      ].join("\n"),
    )
    expect(exec.mock.calls.map(([command]) => command)).toStrictEqual([
      'gh auth token --user "review-account-1"',
      'gh auth token --user "review-account-2"',
      'gh auth token --user "review-account-3"',
      'gh auth token --user "voter-account-1"',
      'gh auth token --user "voter-account-2"',
      'gh auth token --user "voter-account-3"',
      'gh auth token --user "editor-account"',
      'gh auth token --user "creator-account"',
    ])
  })

  test("reports when OpenCode has no models", async ({
    createMagi,
    temporaryDirectory,
  }) => {
    const { magi } = createMagi({ directory: temporaryDirectory })
    const exec = vi.fn<Exec>()

    CONFIG_PATH.GLOBAL = join(temporaryDirectory, "global.json")
    magi.exec = exec
    mocks.getModels.mockResolvedValue([])
    await writeConfig(CONFIG_PATH.GLOBAL, {
      account: "single-account",
      github: { owner: "magi-ai", repo: "opencode-magi" },
    })

    await expect(executeValidate(magi)).resolves.toBe(
      [
        "Magi config validation: failed",
        "",
        "Errors:",
        "- No OpenCode models found.",
      ].join("\n"),
    )
    expect(exec).not.toHaveBeenCalled()
  })

  test("reports when no config file exists", async ({
    createMagi,
    temporaryDirectory,
  }) => {
    const projectPath = join(temporaryDirectory, CONFIG_PATH.PROJECT)
    const { magi } = createMagi({ directory: temporaryDirectory })

    CONFIG_PATH.GLOBAL = join(temporaryDirectory, "global.json")

    await expect(executeValidate(magi)).resolves.toBe(
      [
        "Magi config validation: failed",
        "",
        "Errors:",
        `- No Magi config found. Expected ${CONFIG_PATH.GLOBAL} or ${projectPath}.`,
      ].join("\n"),
    )
  })

  test("reports malformed config JSON", async ({
    createMagi,
    temporaryDirectory,
  }) => {
    const { magi } = createMagi({ directory: temporaryDirectory })

    CONFIG_PATH.GLOBAL = join(temporaryDirectory, "global.json")
    await writeFile(CONFIG_PATH.GLOBAL, "not json")

    const report = await executeValidate(magi)

    expect(report).toContain("Magi config validation: failed")
    expect(report).toContain("not json")
    expect(report).toContain("JSON")
  })

  test("reports config values that are not objects", async ({
    createMagi,
    temporaryDirectory,
  }) => {
    const { magi } = createMagi({ directory: temporaryDirectory })

    CONFIG_PATH.GLOBAL = join(temporaryDirectory, "global.json")
    await writeConfig(CONFIG_PATH.GLOBAL, [])

    await expect(executeValidate(magi)).resolves.toBe(
      [
        "Magi config validation: failed",
        "",
        "Errors:",
        `- Config must be a JSON object: ${CONFIG_PATH.GLOBAL}`,
      ].join("\n"),
    )
  })
})
