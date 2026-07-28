import type { ToolContext } from "@opencode-ai/plugin"
import type { Config } from "@/config"
import type { Magi, State } from "@/magi"
import type { Exec } from "@/utils"
import { access, mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { test } from "#/fixtures/magi"
import { DEFAULT_CONFIG } from "@/constant"
import { clear } from "."

function createConfig(directory: string): Config.Root {
  const config = structuredClone(DEFAULT_CONFIG)

  config.review.output = join(directory, "review-runs")
  config.triage.output = join(directory, "triage-runs")

  return config
}

function createState(output: string, overrides: Partial<State> = {}): State {
  return {
    command: "review",
    createdAt: "2026-07-24T00:00:00.000Z",
    dryRun: false,
    id: "run-1",
    output,
    repo: "magi-ai/opencode-magi",
    sessionId: "parent-session",
    status: "completed",
    updatedAt: "2026-07-24T00:00:00.000Z",
    ...overrides,
  }
}

async function writeState(directory: string, state: State): Promise<void> {
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, "state.json"),
    `${JSON.stringify(state, null, 2)}\n`,
  )
}

async function executeClear(magi: Magi): Promise<string> {
  const clearTool = clear(magi).magi_clear

  if (!clearTool) throw new Error("Clear tool not found.")

  const result = await clearTool.execute({}, {
    abort: new AbortController().signal,
    sessionID: "parent-session",
  } as ToolContext)

  if (typeof result !== "string")
    throw new Error("Clear tool did not return a summary.")

  return result
}

describe("magi:clear", () => {
  test("reports zero when no runs exist", async ({ createMagi, tmpDir }) => {
    const config = createConfig(tmpDir)
    const { client, magi } = createMagi({ dir: tmpDir })
    const exec = vi.fn<Exec>()
    const getConfig = vi.spyOn(magi, "getConfig").mockResolvedValue(config)

    magi.exec = exec

    await expect(executeClear(magi)).resolves.toBe(
      [
        "Cleared Magi runs: 0",
        "Skipped active runs: 0",
        "Sessions deleted: 0",
        "Worktrees deleted: 0",
        "Branches deleted: 0",
        "Outputs deleted: 0",
      ].join("\n"),
    )
    expect(getConfig).toHaveBeenCalledWith()
    expect(client.session.delete).not.toHaveBeenCalled()
    expect(exec).not.toHaveBeenCalled()
  })

  test("clears inactive runs and skips active runs", async ({
    createMagi,
    tmpDir,
  }) => {
    const config = createConfig(tmpDir)
    const completedOutput = join(config.review.output, "42", "run-completed")
    const failedOutput = join(config.triage.output, "42", "run-failed")
    const preparingOutput = join(config.review.output, "42", "run-preparing")
    const runningOutput = join(config.triage.output, "42", "run-running")
    const ignoredOutput = join(config.review.output, "ignored.txt")
    const worktree = join(tmpDir, "worktrees", "run-completed")
    const { client, magi } = createMagi({ dir: tmpDir })
    const exec = vi.fn<Exec>().mockResolvedValue("")

    magi.exec = exec
    client.session.delete.mockResolvedValue({ data: true })
    vi.spyOn(magi, "getConfig").mockResolvedValue(config)

    await Promise.all([
      writeState(
        completedOutput,
        createState(completedOutput, {
          creator: { sessionId: "creator-session" },
          editor: { sessionId: "editor-session" },
          id: "run-completed",
          operator: { sessionId: "operator-session" },
          reviewers: {
            first: { sessionId: "reviewer-session" },
            second: {},
          },
          voters: { first: { sessionId: "voter-session" } },
          worktree: { branch: "feature branch", path: worktree },
        }),
      ),
      writeState(
        failedOutput,
        createState(failedOutput, {
          command: "triage",
          id: "run-failed",
          sessionId: "triage-session",
          status: "failed",
        }),
      ),
      writeState(
        preparingOutput,
        createState(preparingOutput, {
          id: "run-preparing",
          sessionId: "preparing-session",
          status: "preparing",
        }),
      ),
      writeState(
        runningOutput,
        createState(runningOutput, {
          command: "triage",
          id: "run-running",
          sessionId: "running-session",
          status: "running",
        }),
      ),
      mkdir(worktree, { recursive: true }),
    ])
    await Promise.all([
      writeFile(ignoredOutput, "preserved"),
      writeFile(join(worktree, "file.txt"), "content"),
    ])

    await expect(executeClear(magi)).resolves.toBe(
      [
        "Cleared Magi runs: 2",
        "Skipped active runs: 2",
        "Sessions deleted: 7",
        "Worktrees deleted: 1",
        "Branches deleted: 1",
        "Outputs deleted: 2",
      ].join("\n"),
    )
    expect(
      client.session.delete.mock.calls
        .map(([value]) => value.sessionID)
        .sort((first, second) => first.localeCompare(second)),
    ).toStrictEqual([
      "creator-session",
      "editor-session",
      "operator-session",
      "parent-session",
      "reviewer-session",
      "triage-session",
      "voter-session",
    ])
    expect(exec).toHaveBeenCalledWith(
      `git worktree remove --force '${worktree}'`,
    )
    expect(exec).toHaveBeenCalledWith("git branch -D 'feature branch'")
    await expect(access(completedOutput)).rejects.toMatchObject({
      code: "ENOENT",
    })
    await expect(access(failedOutput)).rejects.toMatchObject({ code: "ENOENT" })
    await expect(access(worktree)).rejects.toMatchObject({ code: "ENOENT" })
    await expect(access(preparingOutput)).resolves.toBeUndefined()
    await expect(access(runningOutput)).resolves.toBeUndefined()
    await expect(access(ignoredOutput)).resolves.toBeUndefined()
  })

  test("preserves artifacts when cleanup is disabled", async ({
    createMagi,
    tmpDir,
  }) => {
    const config = createConfig(tmpDir)
    const output = join(config.review.output, "run-completed")
    const worktree = join(tmpDir, "worktrees", "run-completed")
    const { client, magi } = createMagi({ dir: tmpDir })
    const exec = vi.fn<Exec>()

    config.clear = {
      branch: false,
      output: false,
      session: false,
      worktree: false,
    }
    magi.exec = exec
    vi.spyOn(magi, "getConfig").mockResolvedValue(config)
    await writeState(
      output,
      createState(output, {
        worktree: { branch: "feature", path: worktree },
      }),
    )
    await mkdir(worktree, { recursive: true })

    await expect(executeClear(magi)).resolves.toBe(
      [
        "Cleared Magi runs: 1",
        "Skipped active runs: 0",
        "Sessions deleted: 0",
        "Worktrees deleted: 0",
        "Branches deleted: 0",
        "Outputs deleted: 0",
      ].join("\n"),
    )
    expect(client.session.delete).not.toHaveBeenCalled()
    expect(exec).not.toHaveBeenCalled()
    await expect(access(output)).resolves.toBeUndefined()
    await expect(access(worktree)).resolves.toBeUndefined()
  })

  test("continues when cleanup operations fail", async ({
    createMagi,
    tmpDir,
  }) => {
    const config = createConfig(tmpDir)
    const scanDirectory = join(config.review.output, "run-failed")
    const { client, magi } = createMagi({ dir: tmpDir })

    vi.spyOn(magi, "exec").mockRejectedValue(new Error("exec failed"))
    client.session.delete.mockRejectedValue(new Error("delete failed"))
    vi.spyOn(magi, "getConfig").mockResolvedValue(config)
    await writeState(
      scanDirectory,
      createState("\0", {
        worktree: { branch: "feature", path: "\0" },
      }),
    )

    await expect(executeClear(magi)).resolves.toBe(
      [
        "Cleared Magi runs: 1",
        "Skipped active runs: 0",
        "Sessions deleted: 0",
        "Worktrees deleted: 0",
        "Branches deleted: 0",
        "Outputs deleted: 0",
      ].join("\n"),
    )
    expect(client.session.delete).toHaveBeenCalledWith({
      sessionID: "parent-session",
    })
  })

  test("surfaces config errors without clearing runs", async ({
    createMagi,
    tmpDir,
  }) => {
    const { magi } = createMagi({ dir: tmpDir })
    const clearRuns = vi.spyOn(magi, "clear")

    vi.spyOn(magi, "getConfig").mockRejectedValue(new Error("Invalid config"))

    await expect(executeClear(magi)).rejects.toThrow("Invalid config")
    expect(clearRuns).not.toHaveBeenCalled()
  })

  test("surfaces malformed persisted state", async ({ createMagi, tmpDir }) => {
    const config = createConfig(tmpDir)
    const output = join(config.review.output, "run-malformed")
    const { client, magi } = createMagi({ dir: tmpDir })
    const exec = vi.fn<Exec>()

    magi.exec = exec
    vi.spyOn(magi, "getConfig").mockResolvedValue(config)
    await mkdir(output, { recursive: true })
    await writeFile(join(output, "state.json"), "not json")

    await expect(executeClear(magi)).rejects.toThrow(SyntaxError)
    expect(client.session.delete).not.toHaveBeenCalled()
    expect(exec).not.toHaveBeenCalled()
    await expect(access(output)).resolves.toBeUndefined()
  })
})
