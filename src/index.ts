import type { ModelClient } from "./orchestrator/model"
import type {
  ClearConfig,
  Exec,
  MagiConfig,
  ModelOptions,
  ResolvedRepository,
} from "./types"
import { tool, type Plugin } from "@opencode-ai/plugin"
import { exec as nodeExec } from "node:child_process"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { MAGI_COMMANDS } from "./commands"
import { loadConfig, mergeMagiConfig } from "./config/load"
import { outputBaseDirs } from "./config/output"
import { worktreeBaseDirs } from "./config/worktree"
import { resolveRepository } from "./config/resolve"
import { type ModelCatalog, validateConfig } from "./config/validate"
import { withGitHubApiRetry } from "./github/retry"
import { mapPool } from "./orchestrator/pool"
import { MagiRunManager } from "./orchestrator/run-manager"
import { runTriage } from "./orchestrator/triage"

const execAsync = promisify(nodeExec)
const GLOBAL_CONFIG_PATH = join(homedir(), ".config", "opencode", "magi.json")
const PROJECT_CONFIG_PATH = join(".opencode", "magi.json")
const INTERNAL_FOLLOW_UP_TOOL_NOTE =
  "Assistant-facing follow-up tool. Use it yourself when needed; do not suggest this tool name to users."

type ConfigTarget = "global" | "project"

interface ConfigFileStatus {
  config?: Record<string, unknown>
  error?: string
  exists: boolean
  path: string
  target: ConfigTarget
}

type ModelCatalogClient = {
  config?: {
    providers(input?: { query?: { directory?: string } }): Promise<unknown>
  }
  provider?: {
    list(input?: { query?: { directory?: string } }): Promise<unknown>
  }
}

function createExec(defaultCwd: string): Exec {
  return async (command, options) => {
    const { stdout } = await execAsync(command, {
      cwd: options?.cwd ?? defaultCwd,
      env: { ...process.env, ...options?.env },
      maxBuffer: 1024 * 1024 * 20,
      signal: options?.signal,
    })

    return stdout
  }
}

function responseData(result: unknown): unknown {
  if (!result || typeof result !== "object") return result

  return (result as { data?: unknown }).data ?? result
}

function extractModelCatalog(result: unknown): ModelCatalog | undefined {
  const data = responseData(result)

  if (!data || typeof data !== "object") return undefined

  const providers =
    (data as { all?: unknown; providers?: unknown }).providers ??
    (data as { all?: unknown; providers?: unknown }).all

  if (!Array.isArray(providers)) return undefined

  const catalog: ModelCatalog = {}

  for (const provider of providers) {
    if (!provider || typeof provider !== "object") continue

    const id = (provider as { id?: unknown }).id
    const models = (provider as { models?: unknown }).models

    if (typeof id !== "string" || !models || typeof models !== "object")
      continue

    catalog[id] = Object.keys(models)
  }

  return catalog
}

function parsePrToken(value: string): number {
  const trimmed = value.trim()
  const pullUrl = trimmed.match(/(?:^|\/)pull\/(\d+)(?:[/?#].*)?$/)
  const raw = pullUrl?.[1] ?? trimmed.replace(/^#/, "")
  const pr = Number.parseInt(raw, 10)

  if (!Number.isInteger(pr) || pr <= 0 || String(pr) !== raw) {
    throw new Error("Specify one or more PR numbers or PR URLs.")
  }

  return pr
}

function parseIssueToken(value: string): number {
  const trimmed = value.trim()
  const issueUrl = trimmed.match(/(?:^|\/)issues\/(\d+)(?:[/?#].*)?$/)
  const raw = issueUrl?.[1] ?? trimmed.replace(/^#/, "")
  const issue = Number.parseInt(raw, 10)

  if (!Number.isInteger(issue) || issue <= 0 || String(issue) !== raw) {
    throw new Error("Specify one or more issue numbers or issue URLs.")
  }

  return issue
}

export function parsePrs(value: string): number[] {
  const prs = value
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(parsePrToken)

  if (!prs.length) throw new Error("Specify one or more PR numbers or PR URLs.")

  return prs
}

export function parseIssues(value: string): number[] {
  const issues = value
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(parseIssueToken)

  if (!issues.length)
    throw new Error("Specify one or more issue numbers or issue URLs.")

  return issues
}

export function parseRunArguments(
  value: string,
  dryRun = false,
): {
  dryRun: boolean
  prs: number[]
} {
  const tokens = value.split(/[\s,]+/).filter(Boolean)
  const prTokens = tokens.filter((token) => {
    if (token === "--dry-run") {
      dryRun = true
      return false
    }

    return true
  })

  return { dryRun, prs: parsePrs(prTokens.join(" ")) }
}

export function parseIssueRunArguments(
  value: string,
  dryRun = false,
): {
  dryRun: boolean
  issues: number[]
} {
  const tokens = value.split(/[\s,]+/).filter(Boolean)
  const issueTokens = tokens.filter((token) => {
    if (token === "--dry-run") {
      dryRun = true
      return false
    }

    return true
  })

  return { dryRun, issues: parseIssues(issueTokens.join(" ")) }
}

function parseOptionalPr(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined

  return parsePrToken(value)
}

function clearFlag(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined
}

function clearToolFlag(value: unknown): boolean | undefined {
  if (value === true || value === "true") return true
  if (value === "false") return false

  return undefined
}

function hasBlankSelector(args: { pr?: string; runId?: string }): boolean {
  return !args.runId?.trim() && !args.pr?.trim()
}

function hasDefaultedFalseClearFlags(args: {
  branch?: unknown
  output?: unknown
  pr?: string
  runId?: string
  session?: unknown
  worktree?: unknown
}): boolean {
  return (
    hasBlankSelector(args) &&
    args.branch === "false" &&
    args.output === "false" &&
    args.session === "false" &&
    args.worktree === "false"
  )
}

function parseQuestionAnswers(value: string): string[] {
  const trimmed = value.trim()
  if (!trimmed) throw new Error("Specify at least one answer.")

  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (
      Array.isArray(parsed) &&
      parsed.length &&
      parsed.every((item) => typeof item === "string")
    ) {
      return parsed
    }
  } catch {
    // Plain text answers are accepted below.
  }

  return [trimmed]
}

function prMarkdownLink(repository: ResolvedRepository, pr: number): string {
  const host = repository.github.host || "github.com"
  const url = `https://${host}/${repository.github.owner}/${repository.github.repo}/pull/${pr}`

  return `[#${pr}](${url})`
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

async function readConfigFile(
  path: string,
  target: ConfigTarget,
): Promise<ConfigFileStatus> {
  try {
    const config = JSON.parse(await readFile(path, "utf8")) as unknown

    if (!isPlainObject(config)) {
      return {
        error: `${target} config must be a JSON object: ${path}`,
        exists: true,
        path,
        target,
      }
    }

    return { config, exists: true, path, target }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false, path, target }
    }

    return {
      error: `${target} config is invalid JSON at ${path}: ${(error as Error).message}`,
      exists: true,
      path,
      target,
    }
  }
}

function formatConfigStatus(status: ConfigFileStatus): string {
  if (!status.exists) return `- ${status.target}: missing (${status.path})`
  if (status.error) return `- ${status.target}: invalid (${status.path})`

  return `- ${status.target}: found (${status.path})`
}

export async function validateMagiConfigFiles(
  directory: string,
  options: {
    checkAuth?: boolean
    exec?: Exec
    modelCatalog?: ModelCatalog
  } = {},
): Promise<string> {
  const projectPath = join(directory, PROJECT_CONFIG_PATH)
  const statuses = await Promise.all([
    readConfigFile(GLOBAL_CONFIG_PATH, "global"),
    readConfigFile(projectPath, "project"),
  ])
  const existing = statuses.filter((status) => status.exists)
  const hasProjectConfig = statuses.some(
    (status) => status.target === "project" && status.exists,
  )
  const errors = statuses
    .map((status) => status.error)
    .filter((error): error is string => Boolean(error))
  const warnings: string[] = []
  let loadedFrom = "none"

  if (!existing.length) {
    errors.push(
      `No Magi config found. Expected ${GLOBAL_CONFIG_PATH} or ${projectPath}.`,
    )
  }

  if (existing.length && !errors.length) {
    const merged = existing.reduce<Record<string, unknown>>(
      (config, status) => mergeMagiConfig(config, status.config ?? {}),
      {},
    )
    const mergedConfig = merged as unknown as MagiConfig
    const validation = await validateConfig(mergedConfig, {
      checkAuth: options.checkAuth ?? true,
      directory,
      exec: options.exec
        ? withGitHubApiRetry(
            options.exec,
            mergedConfig.github?.apiRetryAttempts ?? 3,
          )
        : undefined,
      modelCatalog: options.modelCatalog,
      requireGithub: hasProjectConfig && Boolean(mergedConfig.review?.agents),
    })

    loadedFrom = existing.map((status) => status.path).join(", ")
    errors.push(...validation.errors)
    warnings.push(...validation.warnings)
  }

  return [
    `Magi config validation: ${errors.length ? "failed" : "passed"}`,
    "",
    "Config files:",
    ...statuses.map(formatConfigStatus),
    "",
    "Effective config:",
    `- loaded from: ${loadedFrom}`,
    `- auth checks: ${(options.checkAuth ?? true) ? "enabled" : "disabled"}`,
    "",
    "Errors:",
    ...(errors.length ? errors.map((error) => `- ${error}`) : ["- None"]),
    "",
    "Warnings:",
    ...(warnings.length
      ? warnings.map((warning) => `- ${warning}`)
      : ["- None"]),
  ].join("\n")
}

export const MagiPlugin: Plugin = async ({ client, directory }) => {
  const exec = createExec(directory)
  const modelClient = client as unknown as ModelClient
  const catalogClient = client as unknown as ModelCatalogClient
  let modelCatalogPromise: Promise<ModelCatalog | undefined> | undefined
  const sessionOptions = new Map<string, ModelOptions>()
  const runManager = new MagiRunManager({
    client: modelClient,
    directory,
    exec,
    setSessionOptions: (sessionId, options) => {
      if (Object.keys(options).length) sessionOptions.set(sessionId, options)
    },
  })

  async function configuredOutputDir(): Promise<string[] | undefined> {
    return loadConfig(directory)
      .then((loaded) => outputBaseDirs(directory, loaded.config))
      .catch(() => undefined)
  }

  async function modelCatalog(): Promise<ModelCatalog | undefined> {
    modelCatalogPromise ??= catalogClient.config
      ?.providers({ query: { directory } })
      .then(extractModelCatalog)
      .catch(() =>
        catalogClient.provider
          ?.list({ query: { directory } })
          .then(extractModelCatalog),
      )

    return modelCatalogPromise
  }

  return {
    "chat.params": async (input, output) => {
      const options = sessionOptions.get(input.sessionID)

      if (options) Object.assign(output.options, options)
    },
    "permission.ask": async (input, output) => {
      const permissionInput = input as {
        sessionID?: unknown
        sessionId?: unknown
      }
      const permissionOutput = output as { status?: "allow" | "ask" | "deny" }
      const sessionId = permissionInput.sessionID ?? permissionInput.sessionId

      if (typeof sessionId === "string" && runManager.hasSession(sessionId)) {
        permissionOutput.status = permissionOutput.status ?? "ask"
      }
    },
    event: async (input) => {
      await runManager.handleEvent(input)
    },
    config: async (config) => {
      config.command = { ...config.command, ...MAGI_COMMANDS }
    },
    tool: {
      magi_merge: tool({
        description: [
          "Start background Magi merge runs for one or more GitHub pull requests with configured Magi agents.",
          "After starting, monitor progress yourself when useful; do not tell users to call follow-up tools by name.",
        ].join(" "),
        args: {
          prs: tool.schema.string(),
          dryRun: tool.schema.boolean().optional(),
        },
        async execute(args, context) {
          const parsed = parseRunArguments(args.prs, args.dryRun ?? false)
          const loaded = await loadConfig(directory)
          const retryingExec = withGitHubApiRetry(
            exec,
            loaded.config.github?.apiRetryAttempts ?? 3,
          )
          const validation = await validateConfig(loaded.config, {
            checkAuth: true,
            directory,
            exec: retryingExec,
            modelCatalog: await modelCatalog(),
            requireEditor: true,
          })

          if (!validation.ok) return JSON.stringify(validation, null, 2)

          const repository = resolveRepository(loaded.config)
          const states = await mapPool(
            parsed.prs,
            repository.concurrency.runs,
            (pr) =>
              runManager.startMerge({
                config: loaded.config,
                dryRun: parsed.dryRun,
                repository,
                pr,
                parentSessionId: context.sessionID,
                signal: context.abort,
              }),
            { signal: context.abort },
          )

          return states
            .map(
              (state) =>
                `Started reviewing ${prMarkdownLink(repository, state.pr as number)}.`,
            )
            .join("\n")
        },
      }),
      magi_review: tool({
        description: [
          "Start background Magi review runs for one or more GitHub pull requests and post the reviews.",
          "After starting, monitor progress yourself when useful; do not tell users to call follow-up tools by name.",
        ].join(" "),
        args: {
          prs: tool.schema.string(),
          dryRun: tool.schema.boolean().optional(),
        },
        async execute(args, context) {
          const parsed = parseRunArguments(args.prs, args.dryRun ?? false)
          const loaded = await loadConfig(directory)
          const retryingExec = withGitHubApiRetry(
            exec,
            loaded.config.github?.apiRetryAttempts ?? 3,
          )
          const validation = await validateConfig(loaded.config, {
            checkAuth: true,
            directory,
            exec: retryingExec,
            modelCatalog: await modelCatalog(),
          })

          if (!validation.ok) return JSON.stringify(validation, null, 2)

          const repository = resolveRepository(loaded.config)
          const states = await mapPool(
            parsed.prs,
            repository.concurrency.runs,
            (pr) =>
              runManager.startReview({
                config: loaded.config,
                dryRun: parsed.dryRun,
                repository,
                pr,
                parentSessionId: context.sessionID,
                signal: context.abort,
              }),
            { signal: context.abort },
          )

          return states
            .map(
              (state) =>
                `Started reviewing ${prMarkdownLink(repository, state.pr as number)}.`,
            )
            .join("\n")
        },
      }),
      magi_triage: tool({
        description:
          "Triage one or more GitHub issues with configured Magi triage agents.",
        args: {
          issues: tool.schema.string(),
          dryRun: tool.schema.boolean().optional(),
        },
        async execute(args, context) {
          const parsed = parseIssueRunArguments(
            args.issues,
            args.dryRun ?? false,
          )
          const loaded = await loadConfig(directory)
          const retryingExec = withGitHubApiRetry(
            exec,
            loaded.config.github?.apiRetryAttempts ?? 3,
          )
          const validation = await validateConfig(loaded.config, {
            checkAuth: true,
            directory,
            exec: retryingExec,
            modelCatalog: await modelCatalog(),
            requireReview: false,
            requireTriage: true,
          })

          if (!validation.ok) return JSON.stringify(validation, null, 2)

          const repository = resolveRepository(loaded.config)
          if (!repository.triage)
            return JSON.stringify(
              { errors: ["triage configuration is required"], ok: false },
              null,
              2,
            )
          const results = await mapPool(
            parsed.issues,
            repository.triage.concurrency.runs,
            (issue) =>
              runTriage({
                client: modelClient,
                config: loaded.config,
                directory,
                dryRun: parsed.dryRun,
                exec: retryingExec,
                issue,
                repository,
                signal: context.abort,
              }),
            { signal: context.abort },
          )

          return results.map((result) => result.report).join("\n\n")
        },
      }),
      magi_status: tool({
        description: [
          "Show Magi background run status. Optionally filter by runId or PR and wait for completion.",
          INTERNAL_FOLLOW_UP_TOOL_NOTE,
        ].join(" "),
        args: {
          runId: tool.schema.string().optional(),
          pr: tool.schema.string().optional(),
          block: tool.schema.boolean().optional(),
          timeoutSeconds: tool.schema.number().optional(),
          verbose: tool.schema.boolean().optional(),
        },
        async execute(args) {
          const states = await runManager.status({
            block: args.block,
            outputDir: await configuredOutputDir(),
            pr: parseOptionalPr(args.pr),
            runId: args.runId,
            timeoutMs:
              args.timeoutSeconds == null
                ? undefined
                : args.timeoutSeconds * 1_000,
          })

          return runManager.formatStatesWithReports(states, {
            verbose: args.verbose ?? false,
          })
        },
      }),
      magi_output: tool({
        description: [
          "Show artifacts and details for a Magi background run by runId or PR, optionally for a single reviewer.",
          INTERNAL_FOLLOW_UP_TOOL_NOTE,
        ].join(" "),
        args: {
          runId: tool.schema.string().optional(),
          pr: tool.schema.string().optional(),
          reviewer: tool.schema.string().optional(),
        },
        async execute(args) {
          if (!args.runId && !args.pr) return "Specify runId or pr."

          const outputDir = await configuredOutputDir()
          if (outputDir) await runManager.status({ outputDir })
          return runManager.output({
            outputDir,
            pr: parseOptionalPr(args.pr),
            reviewer: args.reviewer,
            runId: args.runId,
          })
        },
      }),
      magi_cancel: tool({
        description: "Cancel a Magi background run by runId or PR.",
        args: {
          runId: tool.schema.string().optional(),
          pr: tool.schema.string().optional(),
        },
        async execute(args) {
          if (!args.runId && !args.pr) return "Specify runId or pr."

          const outputDir = await configuredOutputDir()
          if (outputDir) await runManager.status({ outputDir })
          const pr = parseOptionalPr(args.pr)
          const state = await runManager.cancel({
            outputDir,
            pr,
            runId: args.runId,
          })

          if (!state) {
            return args.runId
              ? `Magi run not found: ${args.runId}`
              : `Magi run not found for PR #${pr}`
          }

          return runManager.formatStates([state])
        },
      }),
      magi_clear: tool({
        description:
          "Clear all inactive Magi runs by deleting configured sessions, worktrees, branches, and output artifacts.",
        args: {
          runId: tool.schema.string().optional(),
          pr: tool.schema.string().optional(),
          branch: tool.schema.enum(["true", "false"]).optional(),
          output: tool.schema.enum(["true", "false"]).optional(),
          session: tool.schema.enum(["true", "false"]).optional(),
          worktree: tool.schema.enum(["true", "false"]).optional(),
        },
        async execute(args) {
          const loaded = await loadConfig(directory).catch(() => undefined)
          const clear = loaded?.config.clear as ClearConfig | undefined
          const useConfiguredDefaults = hasDefaultedFalseClearFlags(args)
          const options: ClearConfig = {
            branch:
              (useConfiguredDefaults
                ? undefined
                : clearToolFlag(args.branch)) ?? clearFlag(clear?.branch),
            output:
              (useConfiguredDefaults
                ? undefined
                : clearToolFlag(args.output)) ?? clearFlag(clear?.output),
            session:
              (useConfiguredDefaults
                ? undefined
                : clearToolFlag(args.session)) ?? clearFlag(clear?.session),
            worktree:
              (useConfiguredDefaults
                ? undefined
                : clearToolFlag(args.worktree)) ?? clearFlag(clear?.worktree),
          }

          return runManager.clear({
            options,
            outputDir: loaded
              ? outputBaseDirs(directory, loaded.config)
              : undefined,
            pr: parseOptionalPr(args.pr),
            runId: args.runId,
            worktreeDir: loaded
              ? worktreeBaseDirs(directory, loaded.config)
              : undefined,
          })
        },
      }),
      magi_permission_reply: tool({
        description:
          "Reply to a pending Magi child-agent permission request by runId or PR.",
        args: {
          runId: tool.schema.string().optional(),
          pr: tool.schema.string().optional(),
          agent: tool.schema.string().optional(),
          reviewer: tool.schema.string().optional(),
          requestId: tool.schema.string().optional(),
          reply: tool.schema.string(),
        },
        async execute(args) {
          if (!args.runId && !args.pr) return "Specify runId or pr."
          if (!["always", "once", "reject"].includes(args.reply)) {
            return "reply must be once, always, or reject."
          }

          const outputDir = await configuredOutputDir()
          if (outputDir) await runManager.status({ outputDir })

          return runManager.replyPermission({
            agent: args.agent ?? args.reviewer,
            outputDir,
            pr: parseOptionalPr(args.pr),
            reply: args.reply as "always" | "once" | "reject",
            requestId: args.requestId,
            runId: args.runId,
          })
        },
      }),
      magi_question_reply: tool({
        description:
          "Reply to a pending Magi child-agent question request by runId or PR.",
        args: {
          runId: tool.schema.string().optional(),
          pr: tool.schema.string().optional(),
          agent: tool.schema.string().optional(),
          reviewer: tool.schema.string().optional(),
          requestId: tool.schema.string().optional(),
          answers: tool.schema.string(),
        },
        async execute(args) {
          if (!args.runId && !args.pr) return "Specify runId or pr."

          const outputDir = await configuredOutputDir()
          if (outputDir) await runManager.status({ outputDir })

          return runManager.replyQuestion({
            agent: args.agent ?? args.reviewer,
            answers: parseQuestionAnswers(args.answers),
            outputDir,
            pr: parseOptionalPr(args.pr),
            requestId: args.requestId,
            runId: args.runId,
          })
        },
      }),
      magi_question_reject: tool({
        description:
          "Reject a pending Magi child-agent question request by runId or PR.",
        args: {
          runId: tool.schema.string().optional(),
          pr: tool.schema.string().optional(),
          agent: tool.schema.string().optional(),
          reviewer: tool.schema.string().optional(),
          requestId: tool.schema.string().optional(),
        },
        async execute(args) {
          if (!args.runId && !args.pr) return "Specify runId or pr."

          const outputDir = await configuredOutputDir()
          if (outputDir) await runManager.status({ outputDir })

          return runManager.rejectQuestion({
            agent: args.agent ?? args.reviewer,
            outputDir,
            pr: parseOptionalPr(args.pr),
            requestId: args.requestId,
            runId: args.runId,
          })
        },
      }),
      magi_validate: tool({
        description:
          "Validate global and project Magi config presence, merged settings, reviewer rules, model IDs, and GitHub authentication.",
        args: {
          checkAuth: tool.schema.boolean().optional(),
        },
        async execute(args) {
          return validateMagiConfigFiles(directory, {
            checkAuth: args.checkAuth ?? true,
            exec,
            modelCatalog: await modelCatalog(),
          })
        },
      }),
    },
  }
}

export default MagiPlugin
