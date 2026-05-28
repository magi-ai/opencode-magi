import type {
  PluginInput,
  PluginOptions,
  ToolDefinition,
} from "@opencode-ai/plugin"
import type { ConfigValidationOptions } from "@/config"
import type { Exec } from "@/utils"
import { readdir, readFile, rm } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import { type Config, getConfig, validateConfig } from "@/config"
import { createExec, filterDuplicates, filterEmpty, quote } from "@/utils"

interface State {
  creator?: AgentState
  editor?: AgentState
  outputDir?: string
  reviewers?: { [key: string]: AgentState }
  sessionIds?: { [key: string]: string }
  status?: string
  voters?: { [key: string]: AgentState }
  worktreeBranch?: string
  worktreePath?: string
}

interface AgentState {
  sessionId?: string
}

export interface Tool {
  (magi: Magi): {
    [key: string]: ToolDefinition
  }
}

const active = new Set(["blocked", "posting", "preparing", "running"])

export class Magi {
  public input: PluginInput
  public options: PluginOptions | undefined
  public exec: Exec

  constructor(input: PluginInput, options?: PluginOptions) {
    this.input = input
    this.options = options
    this.exec = createExec(input.directory)
  }

  async clear(config: Config.Root) {
    const summary = {
      branch: 0,
      output: 0,
      run: 0,
      session: 0,
      skipped: 0,
      worktree: 0,
    }
    const states = await this.getStates(config)

    for (const state of states) {
      if (state.status && active.has(state.status)) {
        summary.skipped += 1

        continue
      }

      if (config.clear.session)
        summary.session += await this.deleteSessions(state)

      if (config.clear.worktree && state.worktreePath)
        summary.worktree += await this.deleteWorktree(state.worktreePath)

      if (config.clear.branch && state.worktreeBranch)
        summary.branch += await this.deleteBranch(state.worktreeBranch)

      if (config.clear.output && state.outputDir)
        summary.output += await this.deleteOutput(state.outputDir)

      summary.run += 1
    }

    return summary
  }

  async getConfig(require?: ConfigValidationOptions["require"]) {
    const config = await getConfig(this.input)
    const errors = await validateConfig(config, { exec: this.exec, require })

    if (errors.length) throw new Error(errors.join("\n"))

    return config
  }

  private getPath(value: string) {
    return isAbsolute(value) ? value : join(this.input.directory, value)
  }

  private async getStates(config: Config.Root) {
    const files = await Promise.all([
      this.getStateFiles(config.review.output),
      this.getStateFiles(config.triage.output),
    ])

    return Promise.all(
      files
        .flat()
        .map(async (file) => JSON.parse(await readFile(file, "utf8"))),
    )
  }

  private async getStateFiles(dir: string) {
    try {
      const entries = await readdir(this.getPath(dir), {
        recursive: true,
        withFileTypes: true,
      })

      return entries
        .filter((entry) => entry.isFile() && entry.name === "state.json")
        .map((entry) => join(entry.parentPath, entry.name))
    } catch {
      return []
    }
  }

  private getSessionIds(state: State) {
    return filterDuplicates(
      filterEmpty([
        ...Object.values(state.sessionIds ?? {}),
        ...this.getAgents(state).map(({ sessionId }) => sessionId),
      ]),
    )
  }

  private getAgents(state: State) {
    return filterEmpty([
      state.editor,
      state.creator,
      ...Object.values(state.reviewers ?? {}),
      ...Object.values(state.voters ?? {}),
    ])
  }

  private async deleteSessions(state: State) {
    const sessionIds = this.getSessionIds(state)

    let count = 0

    for (const id of sessionIds) {
      try {
        await this.input.client.session.delete({ path: { id } })

        count += 1
      } catch {}
    }

    return count
  }

  private async deleteWorktree(value: string) {
    try {
      const path = this.getPath(value)

      await this.exec(`git worktree remove --force ${quote(path)}`)
      await rm(path, { force: true, recursive: true })

      return 1
    } catch {
      return 0
    }
  }

  private async deleteBranch(branch: string) {
    try {
      await this.exec(`git branch -D ${quote(branch)}`)

      return 1
    } catch {
      return 0
    }
  }

  private async deleteOutput(path: string) {
    try {
      await rm(path, { force: true, recursive: true })

      return 1
    } catch {
      return 0
    }
  }
}
