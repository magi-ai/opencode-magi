import type { ThrottlingOptions } from "@octokit/plugin-throttling"
import type {
  PluginInput as OriginalPluginInput,
  PluginOptions,
  ToolDefinition,
} from "@opencode-ai/plugin"
import type { DocumentNode } from "graphql"
import type { EditOutput } from "./tools/merge"
import type { Config, ConfigValidationOptions } from "@/config"
import type { Graphql } from "@/graphql"
import type {
  PullRequestAutomation,
  PullRequestChecks,
  PullRequestClosingIssue,
  PullRequestComment,
  PullRequestCommit,
  PullRequestInlineCommentTargets,
  PullRequestMetadata,
  PullRequestReview,
  PullRequestReviewThread,
  PullRequestVerdict,
  ReviewOutput,
} from "@/tools/review"
import type { DeepPartial, Dict, Exec, PluginInput } from "@/utils"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { print } from "graphql"
import { randomUUID } from "node:crypto"
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join } from "node:path"
import { Octokit } from "octokit"
import { getConfig, resolvePermissions, validateConfig } from "@/config"
import { graphql } from "@/graphql"
import {
  command,
  createExec,
  filterEmpty,
  isArray,
  isNumber,
  isObject,
  merge,
  quote,
  rm,
} from "@/utils"

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
  model?: Config.Model
  permissions?: Config.Permissions
  sessionId?: string
}

export interface ReviewerState extends AgentState {
  outputs?: ReviewOutput[]
  posted?: string
  review?: PullRequestReview
  status?: string
}

export interface EditorState extends AgentState {
  author?: Config.Author
  outputs?: EditOutput[]
}

export interface State {
  command: Command
  completedAt?: string
  createdAt: string
  creator?: AgentState
  dryRun: boolean
  editor?: EditorState
  error?: string
  id: string
  issue?: { number: number; url: string }
  operator?: AgentState
  output: string
  pr?: {
    automation?: PullRequestAutomation
    checks?: PullRequestChecks
    comments?: PullRequestComment[]
    commits?: PullRequestCommit[]
    files?: string[]
    inlineCommentTargets?: PullRequestInlineCommentTargets
    issues?: PullRequestClosingIssue[]
    metadata?: PullRequestMetadata
    number: number
    reviews?: PullRequestReview[]
    threads?: PullRequestReviewThread[]
    url: string
    verdict?: PullRequestVerdict
  }
  repo: string
  reviewers?: { [key: string]: ReviewerState }
  sessionId: string
  status: Status
  sync: boolean
  text?: string
  updatedAt: string
  voters?: { [key: string]: AgentState }
  worktree?: {
    branch?: string
    path: string
  }
}

const active: Set<Status> = new Set(["preparing", "running"])
const backgrounds = new Map<number, AbortController>()

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

  public getGhToken(account?: string, signal?: AbortSignal): Promise<string> {
    return this.exec(
      command(
        "gh",
        "auth",
        "token",
        account && "--user",
        account && quote(account),
      ),
      { signal },
    )
  }

  public async createOctokit(
    config: Config.Root,
    signal?: AbortSignal,
    account?: string,
  ): Promise<Octokit> {
    const auth = await this.getGhToken(account)
    const retries = config.github.retryApiAttempts

    return new Octokit({
      auth,
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

  public createGraphql(octokit: Octokit): Graphql {
    return graphql(<T, U>(document: DocumentNode, variables?: U) =>
      octokit.graphql<T>(print(document), variables as Dict),
    )
  }

  public registerBackground(number: number, controller: AbortController): void {
    if (backgrounds.has(number)) this.cancelBackground(number)

    backgrounds.set(number, controller)
  }

  public unregisterBackground(number: number, signal: AbortSignal): void {
    if (backgrounds.get(number)?.signal === signal) backgrounds.delete(number)
  }

  public cancelBackgrounds(numbers?: number[]): {
    cancelled: number[]
    missing: number[]
  } {
    const results: { cancelled: number[]; missing: number[] } = {
      cancelled: [],
      missing: [],
    }

    if (!numbers?.length) numbers = [...backgrounds.keys()]

    for (const number of numbers) {
      const cancelled = this.cancelBackground(number)

      results[cancelled ? "cancelled" : "missing"].push(number)
    }

    return results
  }

  public cancelBackground(number: number): boolean {
    const controller = backgrounds.get(number)

    if (controller) {
      controller.abort()
      backgrounds.delete(number)

      return true
    } else {
      return false
    }
  }

  public async notify(sessionID: string, text: string): Promise<void> {
    await this.input.client.session.promptAsync({
      parts: [{ synthetic: true, text, type: "text" }],
      sessionID,
    })
  }

  public async clear(config: Config.Root): Promise<{
    branch: number
    output: number
    run: number
    session: number
    skipped: number
    worktree: number
  }> {
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

  public getPath(value: string): string {
    return isAbsolute(value) ? value : join(this.input.directory, value)
  }

  public async getConfig(
    require?: ConfigValidationOptions["require"],
  ): Promise<Config.Root> {
    const config = await getConfig(this.input)
    const errors = await validateConfig(config, { exec: this.exec, require })

    if (errors.length) throw new Error(errors.join("\n"))

    return config
  }

  private async getStates(config: Config.Root): Promise<State[]> {
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

  private async getState(dir: string): Promise<State> {
    return JSON.parse(await readFile(join(dir, "state.json"), "utf8")) as State
  }

  private async getStateFiles(dir: string): Promise<string[]> {
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

  private getAgents(state: State): AgentState[] {
    return filterEmpty([
      state.editor,
      state.creator,
      state.operator,
      ...Object.values(state.reviewers ?? {}),
      ...Object.values(state.voters ?? {}),
    ])
  }

  public async createState(
    dir: string,
    initialState: Omit<
      State,
      "createdAt" | "id" | "output" | "status" | "updatedAt"
    >,
  ): Promise<State> {
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
    const values = [this.createStateFile(state)]

    if (!state.sync && state.text)
      values.push(this.notify(state.sessionId, state.text))

    await Promise.all(values)

    return state
  }

  private async createStateFile(state: State): Promise<void> {
    await mkdir(state.output, { recursive: true })
    await writeFile(
      join(state.output, "state.json"),
      `${JSON.stringify(state, null, 2)}\n`,
    )
  }

  public async createAgentFile(
    output: string,
    phase: string,
    id: string,
    content: string,
    attempt = 1,
    cycle?: number,
  ): Promise<void> {
    const segments = [id, phase]

    if (isNumber(cycle)) segments.push(cycle.toString())
    if (isNumber(attempt)) segments.push(attempt.toString())

    const path = join(output, segments.join("-") + ".md")

    await writeFile(path, content)
  }

  public async updateState(
    dir: string,
    next: DeepPartial<State>,
  ): Promise<State> {
    next.updatedAt = new Date().toISOString()

    const prev = await this.getState(dir)
    const state = merge<State>(prev, next)
    const values = [this.createStateFile(state)]

    if (!state.sync && next.text)
      values.push(this.notify(prev.sessionId, next.text))

    await Promise.all(values)

    return state
  }

  private getSessionIds(state: State): string[] {
    return [
      state.sessionId,
      ...filterEmpty(this.getAgents(state).map(({ sessionId }) => sessionId)),
    ]
  }

  public async createSession(
    parentID: string,
    title: string,
    {
      model,
      permissions,
    }: {
      model: Config.Model | undefined
      permissions?: Config.Permissions
    },
  ): Promise<string> {
    if (isArray(model) || !isObject(model)) throw new Error()

    const { id, variant } = model
    const [providerId, modelId] = id.split("/")
    const result = await this.input.client.session.create({
      model: {
        id: modelId!,
        providerID: providerId!,
        variant,
      },
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

  public async promptSession(sessionID: string, text: string): Promise<string> {
    const result = await this.input.client.session.prompt({
      parts: [{ text, type: "text" }],
      sessionID,
    })

    if (result.error) {
      throw new Error(result.response.statusText)
    } else {
      const output = result.data.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n")

      if (!output)
        throw new Error("OpenCode session.prompt did not return text output.")

      return output
    }
  }

  private async deleteSessions(state: State): Promise<number> {
    const sessionIds = this.getSessionIds(state)

    let count = 0

    for (const sessionID of sessionIds)
      try {
        await this.input.client.session.delete({ sessionID })

        count += 1
      } catch {}

    return count
  }

  public async createWorktree(
    dir: string,
    number: number,
    id: string,
    signal?: AbortSignal,
  ): Promise<{ branch?: string; path: string }> {
    const path = this.getPath(join(dir, number.toString(), id))

    try {
      await mkdir(dirname(path), { recursive: true })
      await this.exec(
        command("git", "worktree", "add", "--detach", quote(path)),
        { signal },
      )
      await this.exec(command("gh", "pr", "checkout", number, "--detach"), {
        cwd: path,
        signal,
      })

      const branch = await this.exec("git branch --show-current", {
        cwd: path,
        signal,
      })

      return { branch: branch || undefined, path }
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

  public async deleteWorktree(value: string): Promise<number> {
    try {
      const path = this.getPath(value)

      await this.exec(
        command("git", "worktree", "remove", "--force", quote(path)),
      )
      await rm(path, {
        force: true,
        prune: this.input.directory,
        recursive: true,
      })

      return 1
    } catch {
      return 0
    }
  }

  private async deleteBranch(branch: string): Promise<number> {
    try {
      await this.exec(command("git", "branch", "-D", quote(branch)))

      return 1
    } catch {
      return 0
    }
  }

  private async deleteOutput(path: string): Promise<number> {
    try {
      const resolvedPath = this.getPath(path)

      await rm(resolvedPath, {
        force: true,
        prune: this.input.directory,
        recursive: true,
      })

      return 1
    } catch {
      return 0
    }
  }
}
