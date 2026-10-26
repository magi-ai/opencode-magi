import type { ThrottlingOptions } from "@octokit/plugin-throttling"
import type { Plugin, PluginOptions } from "@opencode/plugin"
import type { Info as ToolDefinition } from "@opencode/plugin/promise/tool"
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
import { print } from "graphql"
import { randomUUID } from "node:crypto"
import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises"
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

export interface Event {
  createdAt: string
  message: string
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
  updatedAt: string
  voters?: { [key: string]: AgentState }
  worktree?: {
    branch?: string
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

  constructor(context: Plugin.Context) {
    this.input = { client: context, directory: context.location.directory }
    this.options = context.options
    this.exec = createExec(context.location.directory)
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
    const auth = await this.getGhToken(account, signal)
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

    await this.createStateFile(state)

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

    await this.createStateFile(state)

    return state
  }

  public async updateEvent(output: string, message: string): Promise<void> {
    const event: Event = {
      createdAt: new Date().toISOString(),
      message,
    }

    await appendFile(join(output, "events.jsonl"), `${JSON.stringify(event)}\n`)
  }

  public async getEvents(output: string): Promise<Event[]> {
    try {
      const content = await readFile(join(output, "events.jsonl"), "utf8")

      return content
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Event)
    } catch (e) {
      if (e instanceof Error && "code" in e && e.code === "ENOENT") return []

      throw e
    }
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
    signal?: AbortSignal,
  ): Promise<string> {
    if (isArray(model) || !isObject(model)) throw new Error()

    const { id, variant } = model
    const [providerId, modelId] = id.split("/")
    const result = await this.input.client.session.create(
      {
        model: {
          id: modelId!,
          providerID: providerId!,
          variant,
        },
        parentID,
        permissions: resolvePermissions(permissions),
        title,
      },
      { signal },
    )

    return result.id
  }

  public async promptSession(
    sessionID: string,
    text: string,
    signal?: AbortSignal,
  ): Promise<string> {
    signal?.throwIfAborted()

    const controller = new AbortController()
    const cancelled = Promise.withResolvers<never>()
    const abort = (): void => cancelled.reject(signal?.reason)
    const events = this.input.client.event.subscribe({
      signal: controller.signal,
    })

    signal?.addEventListener("abort", abort, { once: true })

    try {
      return await Promise.race([
        cancelled.promise,
        this.monitorSession(sessionID, events),
        this.readSessionOutput(
          sessionID,
          text,
          signal
            ? AbortSignal.any([signal, controller.signal])
            : controller.signal,
        ),
      ])
    } catch (e) {
      if (e instanceof MagiError || signal?.aborted)
        await this.input.client.session.interrupt({ resume: false, sessionID })

      throw e
    } finally {
      signal?.removeEventListener("abort", abort)
      controller.abort()
    }
  }

  private async readSessionOutput(
    sessionID: string,
    text: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const prompt = await this.input.client.session.prompt(
      { sessionID, text },
      { signal },
    )

    await this.input.client.session.wait({ sessionID }, { signal })

    const messages = await this.input.client.session.context(
      { sessionID },
      { signal },
    )
    const response = messages.findLast(
      (message) => message.type === "assistant",
    )

    if (!response || response.time.created < prompt.time.created)
      throw new Error("OpenCode session.prompt did not return text output.")
    if (response.error) throw new Error(response.error.message)

    const output = response.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")

    if (!output)
      throw new Error("OpenCode session.prompt did not return text output.")

    return output
  }

  private async monitorSession(
    sessionID: string,
    events: ReturnType<Plugin.Context["event"]["subscribe"]>,
  ): Promise<never> {
    for await (const ev of events) {
      if (ev.type === "permission.asked" && ev.data.sessionID === sessionID) {
        const { action, id, resources } = ev.data

        await this.input.client.permission
          .reply({
            decision: "reject",
            requestID: id,
            sessionID,
          })
          .catch(() => {
            throw new MagiError(
              "blocked",
              "Could not reject permission request.",
            )
          })

        throw new MagiError(
          "blocked",
          `OpenCode session requested ${action} permission for ${resources.join(", ")}.`,
        )
      }

      if (ev.type === "form.created" && ev.data.form.sessionID === sessionID)
        throw new MagiError("blocked", "OpenCode session requested user input.")
    }

    return new Promise<never>(() => {})
  }

  private async deleteSessions(state: State): Promise<number> {
    const sessionIds = this.getSessionIds(state)

    let count = 0

    for (const sessionID of sessionIds)
      try {
        await this.input.client.session.remove({ sessionID })

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
