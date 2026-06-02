import type { ThrottlingOptions } from "@octokit/plugin-throttling"
import type {
  PluginInput as OriginalPluginInput,
  PluginOptions,
  ToolDefinition,
} from "@opencode-ai/plugin"
import type { DocumentNode } from "graphql"
import type { Config, ConfigValidationOptions } from "@/config"
import type {
  PullRequestChecks,
  PullRequestClosingIssue,
  PullRequestComment,
  PullRequestCommit,
  PullRequestMetadata,
  PullRequestReview,
  PullRequestReviewThread,
} from "@/tools/review/review"
import type { DeepPartial, Dict, Exec, PluginInput } from "@/utils"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { print } from "graphql"
import { randomUUID } from "node:crypto"
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join } from "node:path"
import { Octokit } from "octokit"
import { getConfig, resolvePermissions, validateConfig } from "@/config"
import { graphql } from "@/graphql"
import { command, createExec, filterEmpty, merge, quote } from "@/utils"

export interface Tool {
  (magi: Magi): {
    [key: string]: ToolDefinition
  }
}

export type Command = "merge" | "review" | "triage"
export type Status =
  | "blocked"
  | "cancelled"
  | "completed"
  | "failed"
  | "preparing"
  | "running"

export interface AgentState {
  account?: string
  sessionId?: string
  status?: string
}

export interface State {
  checks?: PullRequestChecks
  command: Command
  completedAt?: string
  createdAt: string
  creator?: AgentState
  dryRun: boolean
  editor?: AgentState
  error?: string
  id: string
  issue?: { number: number; url: string }
  output: string
  pr?: {
    comments?: PullRequestComment[]
    commits?: PullRequestCommit[]
    files?: string[]
    issues?: PullRequestClosingIssue[]
    metadata?: PullRequestMetadata
    number: number
    reviews?: PullRequestReview[]
    threads?: PullRequestReviewThread[]
    url: string
  }
  repo: string
  reviewers?: { [key: string]: AgentState }
  sessionId: string
  status: Status
  text?: string
  updatedAt: string
  voters?: { [key: string]: AgentState }
  worktree?: {
    branch: string
    path: string
  }
}

const active: Set<Status> = new Set(["preparing", "running"])

export class MagiError extends Error {
  constructor(
    public status: Status,
    message: string,
  ) {
    super(message)
    this.name = "MagiError"
  }
}

export class Magi {
  public input: PluginInput
  public options: PluginOptions | undefined
  public exec: Exec

  constructor(input: OriginalPluginInput, options?: PluginOptions) {
    const client = createOpencodeClient({
      baseUrl: input.serverUrl.toString(),
      directory: input.directory,
    })

    this.input = { ...input, client }
    this.options = options
    this.exec = createExec(input.directory)
  }

  public async createOctokit(config: Config.Root, signal?: AbortSignal) {
    const token = await this.exec(command("gh", "auth", "token"))
    const retries = config.github.retryApiAttempts

    return new Octokit({
      auth: token.trim(),
      request: { signal },
      retry: { retries },
      throttle: {
        onRateLimit(_, options) {
          if (options.request.retryCount < retries) return true
        },
        onSecondaryRateLimit(_, options) {
          if (options.request.retryCount < retries) return true
        },
      } satisfies ThrottlingOptions,
    })
  }

  public createGraphql(octokit: Octokit) {
    return graphql(<T, U>(document: DocumentNode, variables?: U) =>
      octokit.graphql<T>(print(document), variables as Dict),
    )
  }

  public async createSession(
    parentID: string,
    title: string,
    permissions?: Config.Permissions,
  ) {
    const result = await this.input.client.session.create({
      parentID,
      permission: resolvePermissions(permissions),
      title,
    })

    if (result.error) {
      throw new Error(result.response.statusText)
    } else {
      const id = result.data.id

      return id
    }
  }

  public async createWorktree(
    dir: string,
    number: number,
    id: string,
    signal?: AbortSignal,
  ) {
    const path = this.getPath(join(dir, number.toString(), id))

    try {
      await mkdir(dirname(path), { recursive: true })
      await this.exec(command("git", "worktree", "add", quote(path)), {
        signal,
      })
      await this.exec(command("gh", "pr", "checkout", number), {
        cwd: path,
        signal,
      })
      const branch = (
        await this.exec("git branch --show-current", {
          cwd: path,
          signal,
        })
      ).trim()

      if (!branch) throw new Error("Failed to determine worktree branch")

      return { branch, path }
    } catch (e) {
      try {
        await this.exec(
          command("git", "worktree", "remove", "--force", quote(path)),
        )
        await this.exec(command("git", "worktree", "prune"))
      } catch {}

      throw e
    }
  }

  public async notify(sessionID: string, text: string) {
    await this.input.client.session.promptAsync({
      parts: [{ synthetic: true, text, type: "text" }],
      sessionID,
    })
  }

  public async clear(config: Config.Root) {
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
      if (active.has(state.status)) {
        summary.skipped += 1

        continue
      }

      if (config.clear.session)
        summary.session += await this.deleteSessions(state)

      if (config.clear.worktree && state.worktree?.path)
        summary.worktree += await this.deleteWorktree(state.worktree.path)

      if (config.clear.branch && state.worktree?.branch)
        summary.branch += await this.deleteBranch(state.worktree.branch)

      if (config.clear.output && state.output)
        summary.output += await this.deleteOutput(state.output)

      summary.run += 1
    }

    return summary
  }

  public async getConfig(require?: ConfigValidationOptions["require"]) {
    const config = await getConfig(this.input)
    const errors = await validateConfig(config, { exec: this.exec, require })

    if (errors.length) throw new Error(errors.join("\n"))

    return config
  }

  public async createState(
    dir: string,
    initialState: Omit<
      State,
      "createdAt" | "id" | "output" | "status" | "updatedAt"
    >,
  ) {
    const id = `run-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`
    const createdAt = new Date().toISOString()

    const state: State = {
      createdAt,
      id,
      output: join(this.getPath(dir), id),
      status: "preparing",
      updatedAt: createdAt,
      ...initialState,
    }

    await this.createStateFile(state)

    return state
  }

  public async updateState(dir: string, next: DeepPartial<State>) {
    next.updatedAt = new Date().toISOString()

    const prev = await this.getState(dir)
    const state = merge<State>(prev, next)

    const values = [this.createStateFile(state)]

    if (next.text) values.push(this.notify(prev.sessionId, next.text))

    await Promise.all(values)

    return state
  }

  public getPath(value: string) {
    return isAbsolute(value) ? value : join(this.input.directory, value)
  }

  private async createStateFile(state: State) {
    await mkdir(state.output, { recursive: true })
    await writeFile(
      join(state.output, "state.json"),
      `${JSON.stringify(state, null, 2)}\n`,
    )
  }

  private async getStates(config: Config.Root) {
    const files = await Promise.all([
      this.getStateFiles(config.review.output),
      this.getStateFiles(config.triage.output),
    ])

    return Promise.all(
      files
        .flat()
        .map(async (file) => JSON.parse(await readFile(file, "utf8")) as State),
    )
  }

  private async getState(dir: string) {
    return JSON.parse(await readFile(join(dir, "state.json"), "utf8")) as State
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
    return [
      state.sessionId,
      ...filterEmpty(this.getAgents(state).map(({ sessionId }) => sessionId)),
    ]
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

    for (const sessionID of sessionIds) {
      try {
        await this.input.client.session.delete({ sessionID })

        count += 1
      } catch {}
    }

    return count
  }

  private async deleteWorktree(value: string) {
    try {
      const path = this.getPath(value)

      await this.exec(
        command("git", "worktree", "remove", "--force", quote(path)),
      )
      await rm(path, { force: true, recursive: true })

      return 1
    } catch {
      return 0
    }
  }

  private async deleteBranch(branch: string) {
    try {
      await this.exec(command("git", "branch", "-D", quote(branch)))

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
