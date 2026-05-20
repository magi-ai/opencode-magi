import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { beforeEach, describe, expect, test, vi } from "vitest"
import {
  MagiPlugin,
  parseIssueRunArguments,
  parseIssues,
  parsePrs,
  parseRunArguments,
} from "./index"

const mockState = vi.hoisted(() => ({ home: "" }))

vi.mock("node:os", () => ({
  homedir: () => mockState.home,
}))

async function loadValidateMagiConfigFiles() {
  vi.resetModules()

  return (await import("./index")).validateMagiConfigFiles
}

async function writeConfig(path: string, config: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true })
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`)
}

describe("parsePrs", () => {
  test("parses PR numbers and URLs", () => {
    expect(parsePrs("7581 #7582")).toEqual([7581, 7582])
    expect(
      parsePrs("https://github.com/yamada-ui/yamada-ui/pull/7583/files"),
    ).toEqual([7583])
  })

  test("requires PR numbers or URLs", () => {
    expect(() => parsePrs("")).toThrow(
      "Specify one or more PR numbers or PR URLs.",
    )
    expect(() => parsePrs("abc")).toThrow(
      "Specify one or more PR numbers or PR URLs.",
    )
  })

  test("parses dry-run flag from command arguments", () => {
    expect(parseRunArguments("--dry-run 7581", false)).toEqual({
      dryRun: true,
      prs: [7581],
    })
    expect(parseRunArguments("7581", true)).toEqual({
      dryRun: true,
      prs: [7581],
    })
  })
})

describe("parseIssues", () => {
  test("parses issue numbers and URLs", () => {
    expect(parseIssues("47 #48")).toEqual([47, 48])
    expect(
      parseIssues("https://github.com/magi-ai/opencode-magi/issues/49"),
    ).toEqual([49])
  })

  test("parses dry-run flag from issue arguments", () => {
    expect(parseIssueRunArguments("--dry-run 47", false)).toEqual({
      dryRun: true,
      issues: [47],
    })
  })
})

describe("tool descriptions", () => {
  test("marks follow-up tools as assistant-facing", async () => {
    const plugin = await MagiPlugin({
      client: { session: {} },
      directory: ".",
    } as never)
    const tools = plugin.tool as Record<string, { description: string }>

    expect(tools.magi_review.description).toContain(
      "do not tell users to call follow-up tools by name",
    )
    expect(tools.magi_merge.description).toContain(
      "do not tell users to call follow-up tools by name",
    )
    for (const name of ["magi_status", "magi_output", "magi_cancel"]) {
      expect(tools[name]?.description).toContain(
        "Assistant-facing follow-up tool.",
      )
      expect(tools[name]?.description).toContain(
        "do not suggest this tool name to users",
      )
    }
  })
})

describe("magi_validate", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  test("reports missing global and project configs", async () => {
    const home = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "magi-home-"))
    const directory = await mkdtemp(
      join(process.env.TMPDIR ?? "/tmp", "magi-project-"),
    )
    mockState.home = home
    const validateMagiConfigFiles = await loadValidateMagiConfigFiles()

    const result = await validateMagiConfigFiles(directory, {
      checkAuth: false,
    })

    expect(result).toContain("Magi config validation: failed")
    expect(result).toContain(
      `- global: missing (${home}/.config/opencode/magi.json)`,
    )
    expect(result).toContain(
      `- project: missing (${directory}/.opencode/magi.json)`,
    )
    expect(result).toContain("No Magi config found")
  })

  test("validates merged global and project config", async () => {
    const home = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "magi-home-"))
    const directory = await mkdtemp(
      join(process.env.TMPDIR ?? "/tmp", "magi-project-"),
    )
    mockState.home = home
    const globalPath = join(home, ".config", "opencode", "magi.json")
    const projectPath = join(directory, ".opencode", "magi.json")
    const validateMagiConfigFiles = await loadValidateMagiConfigFiles()

    await writeConfig(globalPath, {
      review: {
        agents: [
          { account: "bot-a", model: "openai/gpt" },
          { account: "bot-b", model: "openai/gpt" },
          { account: "bot-c", model: "openai/gpt" },
        ],
      },
    })
    await writeConfig(projectPath, {
      github: { owner: "owner", repo: "repo" },
      language: "ja",
    })

    const result = await validateMagiConfigFiles(directory, {
      checkAuth: false,
    })

    expect(result).toContain("Magi config validation: passed")
    expect(result).toContain(`- global: found (${globalPath})`)
    expect(result).toContain(`- project: found (${projectPath})`)
    expect(result).toContain(`- loaded from: ${globalPath}, ${projectPath}`)
    expect(result).toContain("Errors:\n- None")
  })

  test("does not require GitHub settings for global-only config", async () => {
    const home = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "magi-home-"))
    const directory = await mkdtemp(
      join(process.env.TMPDIR ?? "/tmp", "magi-project-"),
    )
    mockState.home = home
    const globalPath = join(home, ".config", "opencode", "magi.json")
    const validateMagiConfigFiles = await loadValidateMagiConfigFiles()

    await writeConfig(globalPath, {
      review: {
        agents: [
          { account: "bot-a", model: "openai/gpt" },
          { account: "bot-b", model: "openai/gpt" },
          { account: "bot-c", model: "openai/gpt" },
        ],
      },
    })

    const result = await validateMagiConfigFiles(directory, {
      checkAuth: false,
    })

    expect(result).toContain("Magi config validation: passed")
    expect(result).toContain(`- global: found (${globalPath})`)
    expect(result).toContain("- project: missing")
    expect(result).toContain("Errors:\n- None")
  })

  test("reports invalid JSON with the config path", async () => {
    const home = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "magi-home-"))
    const directory = await mkdtemp(
      join(process.env.TMPDIR ?? "/tmp", "magi-project-"),
    )
    mockState.home = home
    const projectPath = join(directory, ".opencode", "magi.json")
    const validateMagiConfigFiles = await loadValidateMagiConfigFiles()

    await mkdir(join(projectPath, ".."), { recursive: true })
    await writeFile(projectPath, "{\n")

    const result = await validateMagiConfigFiles(directory, {
      checkAuth: false,
    })

    expect(result).toContain("Magi config validation: failed")
    expect(result).toContain(`- project: invalid (${projectPath})`)
    expect(result).toContain(`project config is invalid JSON at ${projectPath}`)
  })

  test("reports invalid config fields", async () => {
    const home = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "magi-home-"))
    const directory = await mkdtemp(
      join(process.env.TMPDIR ?? "/tmp", "magi-project-"),
    )
    mockState.home = home
    const globalPath = join(home, ".config", "opencode", "magi.json")
    const validateMagiConfigFiles = await loadValidateMagiConfigFiles()

    await writeConfig(globalPath, {
      review: {
        agents: [
          { account: "bot-a", model: "openai/gpt" },
          { account: "bot-b", model: "openai/gpt" },
        ],
      },
    })

    const result = await validateMagiConfigFiles(directory, {
      checkAuth: false,
    })

    expect(result).toContain(
      "review.agents must contain an odd number of reviewers",
    )
    expect(result).not.toContain("github.owner is required")
    expect(result).not.toContain("github.repo is required")
  })
})

describe("magi_clear", () => {
  test("keeps default cleanup enabled when false flags are defaulted", async () => {
    const home = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "magi-home-"))
    const directory = await mkdtemp(
      join(process.env.TMPDIR ?? "/tmp", "magi-project-"),
    )
    const outputDir = join(directory, ".magi", "runs", "pr", "1", "run-test")
    const worktreePath = join(directory, ".magi", "worktrees", "pr", "pr-1")
    const deletedSessions: string[] = []
    mockState.home = home
    const { MagiPlugin } = await import("./index")

    await writeConfig(join(directory, ".opencode", "magi.json"), {})
    await mkdir(outputDir, { recursive: true })
    await mkdir(worktreePath, { recursive: true })
    await writeFile(join(outputDir, "artifact.txt"), "artifact")
    await writeFile(
      join(outputDir, "state.json"),
      JSON.stringify({
        command: "review",
        createdAt: "now",
        outputDir,
        phase: "completed",
        pr: 1,
        repository: "repo",
        reviewers: {
          reviewer: {
            account: "bot",
            sessionId: "child-session",
            status: "completed",
          },
        },
        runId: "run-test",
        status: "completed",
        sessionIds: { reviewer: "child-session" },
        updatedAt: "now",
        worktreePath,
      }),
    )

    try {
      const plugin = await MagiPlugin({
        client: {
          session: {
            create: async () => ({ id: "unused" }),
            delete: async (input: { path: { id: string } }) => {
              deletedSessions.push(input.path.id)

              return true
            },
            prompt: async () => ({ info: { text: "{}" } }),
          },
        },
        directory,
      } as never)
      const result = await plugin.tool?.magi_clear.execute(
        {
          branch: "false",
          output: "false",
          pr: "",
          runId: "",
          session: "false",
          worktree: "false",
        } as never,
        { abort: new AbortController().signal, sessionID: "parent" } as never,
      )

      expect(result).toContain("Cleared Magi runs: 1")
      expect(result).toContain("Sessions deleted: 1")
      expect(result).toContain("Worktrees deleted: 1")
      expect(result).toContain("Outputs deleted: 1")
      expect(deletedSessions).toEqual(["child-session"])
      await expect(stat(outputDir)).rejects.toMatchObject({ code: "ENOENT" })
      await expect(stat(worktreePath)).rejects.toMatchObject({ code: "ENOENT" })
    } finally {
      await rm(home, { force: true, recursive: true })
      await rm(directory, { force: true, recursive: true })
    }
  })

  test("uses config when false flags are defaulted", async () => {
    const home = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "magi-home-"))
    const directory = await mkdtemp(
      join(process.env.TMPDIR ?? "/tmp", "magi-project-"),
    )
    const outputDir = join(directory, ".magi", "runs", "pr", "1", "run-test")
    const worktreePath = join(directory, ".magi", "worktrees", "pr", "pr-1")
    const deletedSessions: string[] = []
    mockState.home = home
    const { MagiPlugin } = await import("./index")

    await writeConfig(join(directory, ".opencode", "magi.json"), {
      clear: { output: false, session: false, worktree: true },
    })
    await mkdir(outputDir, { recursive: true })
    await mkdir(worktreePath, { recursive: true })
    await writeFile(join(outputDir, "artifact.txt"), "artifact")
    await writeFile(
      join(outputDir, "state.json"),
      JSON.stringify({
        command: "review",
        createdAt: "now",
        outputDir,
        phase: "completed",
        pr: 1,
        repository: "repo",
        reviewers: {
          reviewer: {
            account: "bot",
            sessionId: "child-session",
            status: "completed",
          },
        },
        runId: "run-test",
        status: "completed",
        sessionIds: { reviewer: "child-session" },
        updatedAt: "now",
        worktreePath,
      }),
    )

    try {
      const plugin = await MagiPlugin({
        client: {
          session: {
            create: async () => ({ id: "unused" }),
            delete: async (input: { path: { id: string } }) => {
              deletedSessions.push(input.path.id)

              return true
            },
            prompt: async () => ({ info: { text: "{}" } }),
          },
        },
        directory,
      } as never)
      const result = await plugin.tool?.magi_clear.execute(
        {
          branch: "false",
          output: "false",
          pr: "",
          runId: "",
          session: "false",
          worktree: "false",
        } as never,
        { abort: new AbortController().signal, sessionID: "parent" } as never,
      )

      expect(result).toContain("Cleared Magi runs: 1")
      expect(result).toContain("Sessions deleted: 0")
      expect(result).toContain("Worktrees deleted: 1")
      expect(result).toContain("Outputs deleted: 0")
      expect(deletedSessions).toEqual([])
      await expect(stat(outputDir)).resolves.toBeDefined()
      await expect(stat(worktreePath)).rejects.toMatchObject({ code: "ENOENT" })
    } finally {
      await rm(home, { force: true, recursive: true })
      await rm(directory, { force: true, recursive: true })
    }
  })
})
