import type {
  ClearConfig,
  Exec,
  MagiConfig,
  ModelOptions,
  ResolvedRepository,
} from "../types"
import { randomUUID } from "node:crypto"
import {
  mkdir,
  readFile,
  readdir,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import {
  issueRunOutputDir,
  outputBaseDirs,
  prRunOutputDir,
} from "../config/output"
import { worktreeBaseDirs } from "../config/worktree"
import {
  removeBranch,
  removeWorktree,
  type CheckWaitReport,
} from "../github/commands"
import { withGitHubApiRetry } from "../github/retry"
import {
  runMerge,
  type MergeRunProgress,
  type ThreadResolutionAttempt,
} from "./merge"
import type { ModelClient } from "./model"
import { runReview, type ReviewRunProgress } from "./review"
import { runTriage, type TriageRunProgress } from "./triage"

export type MagiAgentStatus =
  | "blocked"
  | "cancelled"
  | "completed"
  | "failed"
  | "pending"
  | "repairing"
  | "running"
  | "skipped"

export type MagiRunStatus =
  | "blocked"
  | "cancelled"
  | "completed"
  | "failed"
  | "posting"
  | "preparing"
  | "running"

export interface MagiRunAgentState {
  account: string
  error?: string
  lastUpdate?: string
  parsedPath?: string
  pendingPermission?: {
    id?: string
    patterns?: string[]
    permission?: string
    sessionId?: string
    tool?: string
  }
  pendingQuestion?: {
    id?: string
    questions?: unknown[]
    sessionId?: string
    tool?: string
  }
  rawPath?: string
  repairAttempts: number
  sessionId?: string
  status: MagiAgentStatus
  toolCalls: number
  verdict?: string
}

export interface MagiRunState {
  command: "merge" | "review" | "triage"
  ciReports?: CheckWaitReport[]
  ciClassifiers?: Record<
    string,
    MagiRunAgentState & {
      classification?: string
      promptPath?: string
      reason?: string
    }
  >
  completedAt?: string
  createdAt: string
  editor?: MagiRunAgentState
  error?: string
  dryRun?: boolean
  majority?: string
  outputDir: string
  parentSessionId?: string
  phase: string
  posted?: Record<string, string>
  pr?: number
  prUrl?: string
  issue?: number
  issueUrl?: string
  reportPath?: string
  repository: string
  reviewers: Record<string, MagiRunAgentState>
  runId: string
  sessionIds?: Record<string, string>
  status: MagiRunStatus
  threadAttempts?: Record<string, ThreadResolutionAttempt>
  triageCreator?: MagiRunAgentState
  updatedAt: string
  verdict?: string
  warnings?: string[]
  worktreeBranch?: string
  worktreePath?: string
}

type NumberFilter = number | number[]

export interface MagiClearOptions extends Required<ClearConfig> {}

interface QueuedTriageRun {
  execute: () => Promise<void>
  repository: ResolvedRepository
  runId: string
}

export interface MagiClearSummary {
  branchDeleted: number
  branchFailed: number
  branchSkipped: number
  outputDeleted: number
  outputFailed: number
  runsCleared: number
  runsSkippedActive: number
  sessionDeleted: number
  sessionFailed: number
  worktreeDeleted: number
  worktreeFailed: number
}

type EventInput = {
  event: { properties?: Record<string, unknown>; type: string }
}

const EVENT_LAST_UPDATE_THROTTLE_MS = 5_000

const DEFAULT_CLEAR_OPTIONS: MagiClearOptions = {
  branch: true,
  output: true,
  session: true,
  worktree: true,
}

function createRunId(): string {
  return `run-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`
}

function now(): string {
  return new Date().toISOString()
}

export function redactSecrets(value: string): string {
  return value
    .replace(
      /\b(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN)=('[^']*'|"[^"]*"|\S+)/g,
      "$1=<redacted>",
    )
    .replace(/(password=)([^;'\s]+)/g, "$1<redacted>")
}

function errorMessage(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error))
}

function isActiveStatus(status: MagiRunStatus): boolean {
  return (
    status === "blocked" ||
    status === "preparing" ||
    status === "running" ||
    status === "posting"
  )
}

function matchesNumberFilter(value: number | undefined, filter?: NumberFilter) {
  if (filter == null) return true

  return Array.isArray(filter)
    ? value != null && filter.includes(value)
    : value === filter
}

function hasAllRequestedPrStates(
  states: MagiRunState[],
  pr?: NumberFilter,
): boolean {
  if (pr == null) return true

  const prs = Array.isArray(pr) ? pr : [pr]

  return prs.every((item) => states.some((state) => state.pr === item))
}

function isWithinDirectory(directory: string, path: string): boolean {
  const relation = relative(directory, path)

  return (
    relation === "" || (!relation.startsWith("..") && !isAbsolute(relation))
  )
}

async function pruneEmptyDirectories(input: {
  boundary: string
  recursive?: boolean
  start: string
}): Promise<void> {
  const boundary = resolve(input.boundary)
  const start = resolve(input.start)
  if (!isWithinDirectory(boundary, start) || start === boundary) return

  async function pruneChildren(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const path = join(dir, entry.name)
      await pruneChildren(path)
      await rmdir(path).catch(() => undefined)
    }
  }

  if (input.recursive) await pruneChildren(start)

  let current = start
  while (current !== boundary && isWithinDirectory(boundary, current)) {
    try {
      await rmdir(current)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== "ENOENT") break
    }
    current = dirname(current)
  }
}

function reviewerArtifactBase(
  progressType: "review" | "rereview",
  reviewer: string,
) {
  return `${reviewer}.${progressType}`
}

function prUrl(repository: ResolvedRepository, pr: number): string {
  const host = repository.github.host || "github.com"

  return `https://${host}/${repository.github.owner}/${repository.github.repo}/pull/${pr}`
}

function pullRequestNumberFromUrl(url: string): number | undefined {
  const match = url.match(/(?:^|\/)pull\/(\d+)(?:[/?#].*)?$/)
  if (!match) return undefined

  const pr = Number.parseInt(match[1]!, 10)
  return Number.isInteger(pr) && pr > 0 ? pr : undefined
}

function issueUrl(repository: ResolvedRepository, issue: number): string {
  const host = repository.github.host || "github.com"

  return `https://${host}/${repository.github.owner}/${repository.github.repo}/issues/${issue}`
}

function prMarkdownLink(state: MagiRunState): string {
  if (state.pr == null) return state.runId
  return state.prUrl ? `[#${state.pr}](${state.prUrl})` : `#${state.pr}`
}

function issueMarkdownLink(state: MagiRunState): string {
  if (state.issue == null) return state.runId
  return state.issueUrl
    ? `[#${state.issue}](${state.issueUrl})`
    : `#${state.issue}`
}

function runLabel(state: MagiRunState): string {
  if (state.pr != null) return prMarkdownLink(state)
  if (state.issue != null) return issueMarkdownLink(state)

  return state.runId
}

function reviewerCompletionText(input: {
  pr: string
  reviewer: string
  verdict: string
}): string {
  const reviewer = `**Reviewer ${input.reviewer}**`

  if (input.verdict === "MERGE") {
    return `${reviewer} approved ${input.pr}.`
  }
  if (input.verdict === "CHANGES_REQUESTED") {
    return `${reviewer} requested changes on ${input.pr}.`
  }
  if (input.verdict === "CLOSE") {
    return `${reviewer} requested closing ${input.pr}.`
  }

  return `${reviewer} finished reviewing ${input.pr}.`
}

function reviewDecisionText(input: { pr: string; verdict: string }): string {
  if (input.verdict === "MERGE") return `Reviewers approved ${input.pr}.`
  if (input.verdict === "CHANGES_REQUESTED") {
    return `Reviewers requested changes on ${input.pr}.`
  }
  if (input.verdict === "CLOSE") {
    return `Reviewers requested closing ${input.pr}.`
  }

  return `Reviewers finished reviewing ${input.pr}.`
}

function ciReportText(input: { pr: string; report: CheckWaitReport }): string {
  const failed = input.report.failed.length
  const rerun = input.report.rerun.length
  const recovered = input.report.scopeOutsideRecovered.length
  const unresolved = input.report.scopeOutsideUnresolved.length
  const scopeInside = input.report.scopeInside.length

  return `CI report for ${input.pr}: ${failed} failed, ${scopeInside} scope-in, ${rerun} rerun, ${recovered} recovered, ${unresolved} unresolved.`
}

function closeReconsiderationText(input: {
  pr: string
  reviewer: string
  to: string
}): string {
  if (input.to === "MERGE") {
    return `**Reviewer ${input.reviewer}** changed their close request to approval for ${input.pr}.`
  }
  if (input.to === "CHANGES_REQUESTED") {
    return `**Reviewer ${input.reviewer}** changed their close request to changes requested for ${input.pr}.`
  }

  return `**Reviewer ${input.reviewer}** reconsidered closing ${input.pr}.`
}

function findingsValidationText(input: {
  discarded: number
  kept: number
  pr: string
}): string {
  return `Validated review findings by majority for ${input.pr}: ${input.kept} kept, ${input.discarded} discarded.`
}

function reviewerFailureText(input: {
  error: string
  pr: string
  repairAttempts: number
  reviewer: string
}): string {
  const repairs = repairAttemptsText(input.repairAttempts)

  return `**Reviewer ${input.reviewer}** failed reviewing ${input.pr}${repairs}: ${input.error}`
}

function editorFailureText(input: {
  error: string
  pr: string
  repairAttempts: number
}): string {
  const repairs = repairAttemptsText(input.repairAttempts)

  return `**Editor** failed editing ${input.pr}${repairs}: ${input.error}`
}

function triageCreatorFailureText(input: {
  error: string
  issue: string
  repairAttempts: number
}): string {
  const repairs = repairAttemptsText(input.repairAttempts)

  return `**Triage creator** failed creating an implementation PR for ${input.issue}${repairs}: ${input.error}`
}

function triageDecisionNotification(input: {
  action: string
  issue: string
  result: string
}): string {
  return `Triage decided ${input.issue}: ${input.result}. Planned action: ${input.action}.`
}

function repairAttemptsText(attempts: number): string {
  if (!attempts) return ""

  return ` after ${attempts} JSON regeneration attempt${attempts === 1 ? "" : "s"}`
}

function mergePhaseText(input: {
  phase: string
  pr: string
}): string | undefined {
  if (input.phase === "fetching PR metadata") {
    return `Fetching PR metadata for ${input.pr}.`
  }
  if (input.phase === "fetching existing reviews") {
    return `Fetching existing reviews for ${input.pr}.`
  }
  if (input.phase === "waiting for checks") {
    return `Waiting for checks for ${input.pr}.`
  }
  if (input.phase === "posting reviews") {
    return `Posting review results to GitHub for ${input.pr}.`
  }
  if (input.phase === "waiting for CI checks") {
    return `Waiting for CI checks for ${input.pr}.`
  }
  if (input.phase === "CI checks passed") {
    return `CI checks passed for ${input.pr}.`
  }
  if (input.phase === "investigating failed CI checks") {
    return `Investigating failed CI checks for ${input.pr}.`
  }
  if (input.phase === "fetching failed CI logs") {
    return `Fetching failed CI logs for ${input.pr}.`
  }
  if (input.phase === "classifying CI failures") {
    return `Classifying CI failures for ${input.pr}.`
  }
  if (input.phase === "CI failures classified as scope-in") {
    return `CI failures were classified as scope-in for ${input.pr}.`
  }
  if (input.phase === "scope-out CI failures remain unresolved") {
    return `Scope-out CI failures remain unresolved for ${input.pr}.`
  }
  if (input.phase === "rerunning scope-out CI jobs") {
    return `Rerunning scope-out CI jobs for ${input.pr}.`
  }
  if (input.phase === "waiting for rerun CI checks") {
    return `Waiting for rerun CI checks for ${input.pr}.`
  }
  if (input.phase === "rerun CI checks passed") {
    return `Rerun CI checks passed for ${input.pr}.`
  }
  if (input.phase === "merging PR") return `Merging ${input.pr}.`
  if (input.phase === "closing PR") return `Closing ${input.pr}.`
  if (input.phase === "creating worktree") {
    return `Creating worktree for ${input.pr}.`
  }
  if (input.phase === "validating review findings") {
    return `Validating review findings for ${input.pr}.`
  }
  if (input.phase === "reconsidering close verdicts") {
    return `Reconsidering close verdicts for ${input.pr}.`
  }
  if (input.phase.startsWith("editing cycle")) {
    return `**Editor** started editing ${input.pr}.`
  }
  if (input.phase.startsWith("waiting for checks after edit")) {
    return `Waiting for checks after editing ${input.pr}.`
  }
  if (input.phase.startsWith("rereview cycle")) {
    return `Started re-reviewing ${input.pr}.`
  }

  return `Magi phase for ${input.pr}: ${input.phase}.`
}

function threadLimitText(input: {
  pr: string
  threads: { label: string; url: string }[]
}): string {
  const links = input.threads
    .map((thread) => `[${thread.label}](${thread.url})`)
    .join(", ")

  if (input.threads.length === 1) {
    return `Review thread ${links} reached the resolution attempt limit for ${input.pr}.`
  }

  return `Review threads ${links} reached the resolution attempt limit for ${input.pr}.`
}

function extractSessionId(
  properties: Record<string, unknown> | undefined,
): string | undefined {
  if (!properties) return undefined

  const direct = properties.sessionID ?? properties.sessionId
  if (typeof direct === "string") return direct

  const info = properties.info
  if (info && typeof info === "object") {
    const value =
      (info as { id?: unknown; sessionID?: unknown; sessionId?: unknown })
        .sessionID ??
      (info as { id?: unknown; sessionID?: unknown; sessionId?: unknown })
        .sessionId ??
      (info as { id?: unknown; sessionID?: unknown; sessionId?: unknown }).id
    if (typeof value === "string") return value
  }

  const part = properties.part
  if (part && typeof part === "object") {
    const value =
      (part as { sessionID?: unknown; sessionId?: unknown }).sessionID ??
      (part as { sessionID?: unknown; sessionId?: unknown }).sessionId
    if (typeof value === "string") return value
  }

  return undefined
}

function extractToolPart(properties: Record<string, unknown> | undefined):
  | {
      callId?: string
      id?: string
      input?: Record<string, unknown>
      status?: string
      tool?: string
    }
  | undefined {
  if (!properties) return undefined
  const part =
    properties.part && typeof properties.part === "object"
      ? (properties.part as Record<string, unknown>)
      : properties
  const type = typeof part.type === "string" ? part.type : undefined
  const tool = typeof part.tool === "string" ? part.tool : undefined
  const state =
    part.state && typeof part.state === "object"
      ? (part.state as Record<string, unknown>)
      : undefined

  if (!tool && type !== "tool") return undefined

  return {
    callId: typeof part.callID === "string" ? part.callID : undefined,
    id: typeof part.id === "string" ? part.id : undefined,
    input:
      state?.input && typeof state.input === "object"
        ? (state.input as Record<string, unknown>)
        : undefined,
    status: typeof state?.status === "string" ? state.status : undefined,
    tool,
  }
}

function extractQuestions(
  input: Record<string, unknown> | undefined,
): unknown[] | undefined {
  return Array.isArray(input?.questions) ? input.questions : undefined
}

function formatQuestionRequest(
  question: MagiRunAgentState["pendingQuestion"],
): string | undefined {
  if (!question?.questions?.length) return undefined

  return question.questions
    .map((item, index) => {
      if (!item || typeof item !== "object")
        return `${index + 1}. ${String(item)}`

      const record = item as Record<string, unknown>
      const header =
        typeof record.header === "string" ? record.header : undefined
      const text =
        typeof record.question === "string" ? record.question : undefined
      const options = Array.isArray(record.options)
        ? record.options
            .map((option) => {
              if (!option || typeof option !== "object") return undefined
              const label = (option as Record<string, unknown>).label
              return typeof label === "string" ? label : undefined
            })
            .filter((value): value is string => Boolean(value))
        : []
      const suffix = options.length ? ` Options: ${options.join(", ")}.` : ""

      return `${index + 1}. ${header ? `${header}: ` : ""}${text ?? JSON.stringify(item)}${suffix}`
    })
    .join("\n")
}

function questionWaitText(input: {
  agent: string
  pr: string
  question: MagiRunAgentState["pendingQuestion"]
}): string {
  const details = formatQuestionRequest(input.question)
  const request = input.question?.id ? ` Request: ${input.question.id}.` : ""

  return [
    `Magi ${input.agent} is waiting for a question answer on ${input.pr}.${request}`,
    details
      ? `Question:\n${details}`
      : "Question details were not included in the event.",
  ].join("\n")
}

function extractPermissionRequest(
  properties: Record<string, unknown> | undefined,
):
  | {
      id?: string
      patterns?: string[]
      permission?: string
      sessionId?: string
      tool?: string
    }
  | undefined {
  if (!properties) return undefined

  const sessionId = extractSessionId(properties)
  const id =
    typeof properties.id === "string"
      ? properties.id
      : typeof properties.requestID === "string"
        ? properties.requestID
        : typeof properties.permissionID === "string"
          ? properties.permissionID
          : undefined
  const permission =
    typeof properties.permission === "string"
      ? properties.permission
      : typeof properties.type === "string"
        ? properties.type
        : undefined
  const patterns = Array.isArray(properties.patterns)
    ? properties.patterns.filter(
        (item): item is string => typeof item === "string",
      )
    : undefined
  const tool =
    typeof properties.tool === "string"
      ? properties.tool
      : properties.tool && typeof properties.tool === "object"
        ? typeof (properties.tool as { name?: unknown }).name === "string"
          ? (properties.tool as { name: string }).name
          : undefined
        : undefined

  if (!sessionId && !id && !permission && !tool) return undefined

  return { id, patterns, permission, sessionId, tool }
}

function extractQuestionRequest(
  properties: Record<string, unknown> | undefined,
):
  | {
      id?: string
      questions?: unknown[]
      sessionId?: string
      tool?: string
    }
  | undefined {
  if (!properties) return undefined

  const sessionId = extractSessionId(properties)
  const id =
    typeof properties.id === "string"
      ? properties.id
      : typeof properties.requestID === "string"
        ? properties.requestID
        : typeof properties.questionID === "string"
          ? properties.questionID
          : undefined
  const questions = Array.isArray(properties.questions)
    ? properties.questions
    : undefined
  const tool =
    typeof properties.tool === "string"
      ? properties.tool
      : properties.tool && typeof properties.tool === "object"
        ? typeof (properties.tool as { name?: unknown }).name === "string"
          ? (properties.tool as { name: string }).name
          : undefined
        : undefined

  if (!sessionId && !id && !questions && !tool) return undefined

  return { id, questions, sessionId, tool }
}

export class MagiRunManager {
  private active = new Map<string, MagiRunState>()
  private activeTriageRuns = 0
  private countedToolParts = new Map<string, Set<string>>()
  private controllers = new Map<string, AbortController>()
  private eventLastUpdates = new Map<string, number>()
  private notifiedPermissions = new Map<string, Set<string>>()
  private runPaths = new Map<string, string>()
  private outputDirs = new Set<string>()
  private sessionToRun = new Map<string, { agent: string; runId: string }>()
  private triageQueue: QueuedTriageRun[] = []

  constructor(
    private readonly input: {
      client: ModelClient
      directory: string
      exec: Exec
      setSessionOptions?: (sessionId: string, options: ModelOptions) => void
    },
  ) {}

  async startReview(input: {
    config: MagiConfig
    dryRun?: boolean
    parentSessionId?: string
    pr: number
    repository: ResolvedRepository
    signal?: AbortSignal
    sync?: boolean
    timeoutMs?: number
  }): Promise<MagiRunState> {
    const runId = createRunId()
    const outputDir = prRunOutputDir({
      config: input.config,
      directory: this.input.directory,
      pr: input.pr,
      runId,
    })
    const createdAt = now()
    const state: MagiRunState = {
      command: "review",
      createdAt,
      dryRun: input.dryRun,
      outputDir,
      parentSessionId: input.parentSessionId,
      phase: "queued",
      pr: input.pr,
      prUrl: prUrl(input.repository, input.pr),
      repository: input.repository.alias,
      reviewers: Object.fromEntries(
        input.repository.agents.reviewers.map((reviewer) => [
          reviewer.key,
          {
            account: reviewer.account,
            repairAttempts: 0,
            status: "pending" as const,
            toolCalls: 0,
          },
        ]),
      ),
      runId,
      status: "preparing",
      updatedAt: createdAt,
    }

    this.active.set(runId, state)
    this.runPaths.set(runId, join(outputDir, "state.json"))
    for (const dir of outputBaseDirs(this.input.directory, input.config))
      this.outputDirs.add(dir)
    await this.persist(state)
    await this.notify(
      state,
      `Started Magi review for ${prMarkdownLink(state)}.`,
    )

    const controller = new AbortController()
    this.controllers.set(runId, controller)

    const execute = () =>
      this.executeReview({
        ...input,
        runId,
        signal: controller.signal,
      })
    if (input.sync)
      return this.executeSync(state, controller, execute, input.timeoutMs)

    void execute().catch(async (error) => {
      await this.failRun(runId, error)
    })

    return state
  }

  async startMerge(input: {
    config: MagiConfig
    dryRun?: boolean
    parentSessionId?: string
    pr: number
    repository: ResolvedRepository
    signal?: AbortSignal
    sync?: boolean
    timeoutMs?: number
  }): Promise<MagiRunState> {
    const runId = createRunId()
    const outputDir = prRunOutputDir({
      config: input.config,
      directory: this.input.directory,
      pr: input.pr,
      runId,
    })
    const createdAt = now()
    const editor = input.repository.agents.editor
    const state: MagiRunState = {
      command: "merge",
      createdAt,
      dryRun: input.dryRun,
      editor: editor
        ? {
            account: editor.account,
            repairAttempts: 0,
            status: "pending",
            toolCalls: 0,
          }
        : undefined,
      outputDir,
      parentSessionId: input.parentSessionId,
      phase: "queued",
      pr: input.pr,
      prUrl: prUrl(input.repository, input.pr),
      repository: input.repository.alias,
      reviewers: Object.fromEntries(
        input.repository.agents.reviewers.map((reviewer) => [
          reviewer.key,
          {
            account: reviewer.account,
            repairAttempts: 0,
            status: "pending" as const,
            toolCalls: 0,
          },
        ]),
      ),
      runId,
      status: "preparing",
      updatedAt: createdAt,
    }

    this.active.set(runId, state)
    this.runPaths.set(runId, join(outputDir, "state.json"))
    for (const dir of outputBaseDirs(this.input.directory, input.config))
      this.outputDirs.add(dir)
    await this.persist(state)
    await this.notify(state, `Started Magi merge for ${prMarkdownLink(state)}.`)

    const controller = new AbortController()
    this.controllers.set(runId, controller)

    const execute = () =>
      this.executeMerge({
        ...input,
        runId,
        signal: controller.signal,
      })
    if (input.sync)
      return this.executeSync(state, controller, execute, input.timeoutMs)

    void execute().catch(async (error) => {
      await this.failRun(runId, error)
    })

    return state
  }

  async startTriage(input: {
    config: MagiConfig
    dryRun?: boolean
    issue: number
    parentSessionId?: string
    repository: ResolvedRepository
    signal?: AbortSignal
    sync?: boolean
    timeoutMs?: number
  }): Promise<MagiRunState> {
    const runId = createRunId()
    const outputDir = issueRunOutputDir({
      config: input.config,
      directory: this.input.directory,
      issue: input.issue,
      runId,
    })
    const createdAt = now()
    const state: MagiRunState = {
      command: "triage",
      createdAt,
      dryRun: input.dryRun,
      issue: input.issue,
      issueUrl: issueUrl(input.repository, input.issue),
      outputDir,
      parentSessionId: input.parentSessionId,
      phase: "queued",
      repository: input.repository.alias,
      reviewers: Object.fromEntries(
        (input.repository.agents.triage ?? []).map((agent) => [
          agent.key,
          {
            account: "",
            repairAttempts: 0,
            status: "pending" as const,
            toolCalls: 0,
          },
        ]),
      ),
      runId,
      status: "preparing",
      triageCreator: input.repository.agents.triageCreator
        ? {
            account: input.repository.agents.triageCreator.account,
            repairAttempts: 0,
            status: "pending",
            toolCalls: 0,
          }
        : undefined,
      updatedAt: createdAt,
    }

    this.active.set(runId, state)
    this.runPaths.set(runId, join(outputDir, "state.json"))
    for (const dir of outputBaseDirs(this.input.directory, input.config))
      this.outputDirs.add(dir)
    await this.persist(state)
    await this.notify(
      state,
      `Started Magi triage for ${issueMarkdownLink(state)}.`,
    )

    const controller = new AbortController()
    this.controllers.set(runId, controller)

    const execute = () =>
      this.executeTriage({
        ...input,
        runId,
        signal: controller.signal,
      })
    if (input.sync)
      return this.executeSync(state, controller, execute, input.timeoutMs)

    this.triageQueue.push({
      execute,
      repository: input.repository,
      runId,
    })
    this.drainTriageQueue()

    return state
  }

  private drainTriageQueue(): void {
    while (this.triageQueue.length) {
      const next = this.triageQueue[0]
      if (!next) return
      const limit = next.repository.triage?.concurrency.runs ?? 1
      if (this.activeTriageRuns >= limit) return
      this.triageQueue.shift()

      const state = this.active.get(next.runId)
      if (!state || state.status === "cancelled") continue

      this.activeTriageRuns += 1
      void next
        .execute()
        .catch(async (error) => {
          await this.failRun(next.runId, error)
        })
        .finally(() => {
          this.activeTriageRuns -= 1
          this.drainTriageQueue()
        })
    }
  }

  async status(
    input: {
      block?: boolean
      issue?: number
      outputDir?: string | string[]
      pr?: NumberFilter
      runId?: string
      timeoutMs?: number
    } = {},
  ): Promise<MagiRunState[]> {
    const timeoutMs = input.timeoutMs
    const startedAt = Date.now()

    while (input.block) {
      const states = await this.filteredStates(input)
      if (
        states.length &&
        hasAllRequestedPrStates(states, input.pr) &&
        states.every((state) => !isActiveStatus(state.status))
      )
        return states
      if (timeoutMs != null && Date.now() - startedAt >= timeoutMs)
        return states
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    }

    return this.filteredStates(input)
  }

  hasSession(sessionId: string): boolean {
    return this.sessionToRun.has(sessionId)
  }

  async output(input: {
    command?: MagiRunState["command"]
    issue?: number
    outputDir?: string | string[]
    pr?: number
    reviewer?: string
    runId?: string
  }): Promise<string> {
    const state = await this.selectState(input)
    if (!state) return `Magi run not found: ${this.selectorText(input)}`

    if (input.reviewer) {
      const reviewer = this.agentState(state, input.reviewer)
      if (!reviewer)
        return `Agent not found in ${this.selectorText(input)}: ${input.reviewer}`

      const sections = [
        `# ${input.reviewer}`,
        `status: ${reviewer.status}`,
        reviewer.sessionId ? `session: ${reviewer.sessionId}` : undefined,
        reviewer.verdict ? `verdict: ${reviewer.verdict}` : undefined,
        reviewer.error ? `error: ${reviewer.error}` : undefined,
      ].filter(Boolean)

      if (reviewer.parsedPath) {
        sections.push("\n## Parsed")
        sections.push(
          await readFile(reviewer.parsedPath, "utf8").catch(
            () => "(missing parsed artifact)",
          ),
        )
      }
      if (reviewer.rawPath) {
        sections.push("\n## Raw")
        sections.push(
          await readFile(reviewer.rawPath, "utf8").catch(
            () => "(missing raw artifact)",
          ),
        )
      }

      return sections.join("\n")
    }

    const sections = [this.formatStates([state], { verbose: true })]

    if (state.reportPath) {
      sections.push("\n## Report")
      sections.push(
        await readFile(state.reportPath, "utf8").catch(
          () => "(missing report artifact)",
        ),
      )
    }
    const output = sections.join("\n")

    return output
  }

  async cancel(
    input:
      | string
      | {
          issue?: number
          outputDir?: string | string[]
          pr?: number
          runId?: string
        },
  ): Promise<MagiRunState | undefined> {
    const selector = typeof input === "string" ? { runId: input } : input
    const state = await this.selectState(selector)
    if (!state) return undefined
    const runId = state.runId

    this.controllers.get(runId)?.abort()

    state.status = "cancelled"
    state.phase = "cancelled"
    state.completedAt = now()
    if (
      state.editor?.status === "pending" ||
      state.editor?.status === "running" ||
      state.editor?.status === "repairing"
    ) {
      state.editor.status = "cancelled"
    }
    if (state.editor?.sessionId) {
      await this.input.client.session
        .abort?.({ path: { id: state.editor.sessionId } })
        .catch(() => undefined)
    }
    if (
      state.triageCreator?.status === "pending" ||
      state.triageCreator?.status === "running" ||
      state.triageCreator?.status === "repairing" ||
      state.triageCreator?.status === "blocked"
    ) {
      state.triageCreator.status = "cancelled"
    }
    if (state.triageCreator?.sessionId) {
      await this.input.client.session
        .abort?.({ path: { id: state.triageCreator.sessionId } })
        .catch(() => undefined)
    }
    for (const reviewer of Object.values(state.reviewers)) {
      if (
        reviewer.status === "pending" ||
        reviewer.status === "running" ||
        reviewer.status === "repairing" ||
        reviewer.status === "blocked"
      ) {
        reviewer.status = "cancelled"
      }
      if (reviewer.sessionId) {
        await this.input.client.session
          .abort?.({ path: { id: reviewer.sessionId } })
          .catch(() => undefined)
      }
    }
    for (const classifier of Object.values(state.ciClassifiers ?? {})) {
      if (
        classifier.status === "pending" ||
        classifier.status === "running" ||
        classifier.status === "repairing" ||
        classifier.status === "blocked"
      ) {
        classifier.status = "cancelled"
      }
      if (classifier.sessionId) {
        await this.input.client.session
          .abort?.({ path: { id: classifier.sessionId } })
          .catch(() => undefined)
      }
    }
    if (state.worktreePath) {
      await removeWorktree(this.input.exec, state.worktreePath).catch(
        () => undefined,
      )
    }
    await this.persist(state)
    await this.notify(
      state,
      `Cancelled ${state.command} for ${runLabel(state)}.`,
      { reply: true },
    )
    this.active.delete(runId)
    this.controllers.delete(runId)
    return state
  }

  async clear(input: {
    issue?: number
    options?: ClearConfig
    outputDir?: string | string[]
    pr?: number
    runId?: string
    worktreeDir?: string | string[]
  }): Promise<string> {
    const configured = input.options ?? {}
    const options: MagiClearOptions = {
      branch: configured.branch ?? DEFAULT_CLEAR_OPTIONS.branch,
      output: configured.output ?? DEFAULT_CLEAR_OPTIONS.output,
      session: configured.session ?? DEFAULT_CLEAR_OPTIONS.session,
      worktree: configured.worktree ?? DEFAULT_CLEAR_OPTIONS.worktree,
    }
    const states = await this.filteredStates(input)
    const cleanupDirs = new Set<string>(this.absoluteWorktreeDirs(input))
    const cleanupTrees = new Set(this.emptyOutputCleanupRoots(input))
    const summary: MagiClearSummary = {
      branchDeleted: 0,
      branchFailed: 0,
      branchSkipped: 0,
      outputDeleted: 0,
      outputFailed: 0,
      runsCleared: 0,
      runsSkippedActive: 0,
      sessionDeleted: 0,
      sessionFailed: 0,
      worktreeDeleted: 0,
      worktreeFailed: 0,
    }
    const lines: string[] = []

    if (!states.length) {
      await this.pruneEmptyMagiDirectories({
        dirs: cleanupDirs,
        trees: cleanupTrees,
      })

      return `No Magi runs found: ${this.selectorText(input)}`
    }

    for (const state of states) {
      if (isActiveStatus(state.status)) {
        summary.runsSkippedActive += 1
        lines.push(
          `Skipped active run ${state.runId} for ${runLabel(state)}: ${state.status}`,
        )
        continue
      }

      if (options.session) {
        if (!this.input.client.session.delete) {
          summary.sessionFailed += this.collectSessionIds(state).length
          lines.push("OpenCode client does not support session deletion.")
        } else {
          for (const sessionId of this.collectSessionIds(state)) {
            try {
              await this.input.client.session.delete({
                path: { id: sessionId },
              })
              summary.sessionDeleted += 1
            } catch (error) {
              summary.sessionFailed += 1
              lines.push(
                `Failed to delete session ${sessionId}: ${(error as Error).message}`,
              )
            }
          }
        }
      }

      if (options.worktree && state.worktreePath) {
        let removed = false
        let unregisterError: unknown

        try {
          await removeWorktree(this.input.exec, state.worktreePath)
          removed = true
        } catch (error) {
          unregisterError = error
        }

        try {
          await rm(state.worktreePath, { force: true, recursive: true })
          removed = true
        } catch (error) {
          summary.worktreeFailed += 1
          if (unregisterError) {
            lines.push(
              `Failed to unregister worktree ${state.worktreePath}: ${(unregisterError as Error).message}`,
            )
          }
          lines.push(
            `Failed to delete worktree directory ${state.worktreePath}: ${(error as Error).message}`,
          )
        }

        if (removed) summary.worktreeDeleted += 1
        cleanupDirs.add(state.worktreePath)
      }

      if (options.branch) {
        if (state.worktreeBranch) {
          try {
            await removeBranch(this.input.exec, state.worktreeBranch)
            summary.branchDeleted += 1
          } catch (error) {
            summary.branchFailed += 1
            lines.push(
              `Failed to delete branch ${state.worktreeBranch}: ${(error as Error).message}`,
            )
          }
        } else {
          summary.branchSkipped += 1
        }
      }

      if (options.output) {
        try {
          await rm(state.outputDir, { force: true, recursive: true })
          summary.outputDeleted += 1
          cleanupDirs.add(state.outputDir)
        } catch (error) {
          summary.outputFailed += 1
          lines.push(
            `Failed to delete output ${state.outputDir}: ${(error as Error).message}`,
          )
        }
      }

      this.active.delete(state.runId)
      this.controllers.delete(state.runId)
      this.runPaths.delete(state.runId)
      summary.runsCleared += 1
      lines.push(`Cleared run ${state.runId} for ${runLabel(state)}.`)
    }

    await this.pruneEmptyMagiDirectories({
      dirs: cleanupDirs,
      trees: cleanupTrees,
    })

    return this.formatClearSummary(summary, lines)
  }

  async replyPermission(input: {
    agent?: string
    outputDir?: string | string[]
    pr?: number
    requestId?: string
    reply: "always" | "once" | "reject"
    runId?: string
  }): Promise<string> {
    const state = await this.selectState(input)
    if (!state) return `Magi run not found: ${this.selectorText(input)}`

    const selected = this.selectPendingAgent(
      state,
      "permission",
      input.agent,
      input.requestId,
    )
    if (typeof selected === "string") return selected

    const requestId = input.requestId ?? selected.state.pendingPermission?.id
    if (!requestId)
      return `Permission request id not found for ${selected.key}.`
    if (!this.input.client.permission?.reply) {
      return "OpenCode client does not support permission replies."
    }

    await this.input.client.permission.reply({
      requestID: requestId,
      reply: input.reply,
    })
    selected.state.pendingPermission = undefined
    if (
      !selected.state.pendingQuestion &&
      selected.state.status === "blocked"
    ) {
      selected.state.status = "running"
    }
    if (state.status === "blocked" && !this.hasBlockedAgents(state)) {
      state.status = "running"
    }
    await this.persist(state)

    return `Replied to permission request ${requestId} for ${selected.key}: ${input.reply}.`
  }

  async replyQuestion(input: {
    agent?: string
    answers: string[]
    outputDir?: string | string[]
    pr?: number
    requestId?: string
    runId?: string
  }): Promise<string> {
    const state = await this.selectState(input)
    if (!state) return `Magi run not found: ${this.selectorText(input)}`

    const selected = this.selectPendingAgent(
      state,
      "question",
      input.agent,
      input.requestId,
    )
    if (typeof selected === "string") return selected

    const requestId = input.requestId ?? selected.state.pendingQuestion?.id
    if (!requestId) return `Question request id not found for ${selected.key}.`
    if (!this.input.client.question?.reply) {
      return "OpenCode client does not support question replies."
    }

    await this.input.client.question.reply({
      answers: input.answers,
      requestID: requestId,
    })
    selected.state.pendingQuestion = undefined
    if (
      !selected.state.pendingPermission &&
      selected.state.status === "blocked"
    ) {
      selected.state.status = "running"
    }
    if (state.status === "blocked" && !this.hasBlockedAgents(state)) {
      state.status = "running"
    }
    await this.persist(state)

    return `Replied to question request ${requestId} for ${selected.key}.`
  }

  async rejectQuestion(input: {
    agent?: string
    outputDir?: string | string[]
    pr?: number
    requestId?: string
    runId?: string
  }): Promise<string> {
    const state = await this.selectState(input)
    if (!state) return `Magi run not found: ${this.selectorText(input)}`

    const selected = this.selectPendingAgent(
      state,
      "question",
      input.agent,
      input.requestId,
    )
    if (typeof selected === "string") return selected

    const requestId = input.requestId ?? selected.state.pendingQuestion?.id
    if (!requestId) return `Question request id not found for ${selected.key}.`
    if (!this.input.client.question?.reject) {
      return "OpenCode client does not support question rejection."
    }

    await this.input.client.question.reject({ requestID: requestId })
    selected.state.pendingQuestion = undefined
    if (
      !selected.state.pendingPermission &&
      selected.state.status === "blocked"
    ) {
      selected.state.status = "running"
    }
    if (state.status === "blocked" && !this.hasBlockedAgents(state)) {
      state.status = "running"
    }
    await this.persist(state)

    return `Rejected question request ${requestId} for ${selected.key}.`
  }

  async handleEvent(input: EventInput): Promise<void> {
    const sessionId = extractSessionId(input.event.properties)
    if (!sessionId) return

    const mapping = this.sessionToRun.get(sessionId)
    if (!mapping) return

    const state =
      this.active.get(mapping.runId) ??
      (await this.readStateByRunId(mapping.runId))
    if (!state) return
    const agent = this.agentState(state, mapping.agent)
    if (!agent) return

    let dirty = false
    const receivedAt = now()
    const receivedAtMs = Date.now()
    const markUpdated = (force = false) => {
      const last = this.eventLastUpdates.get(sessionId) ?? 0

      if (!force && receivedAtMs - last < EVENT_LAST_UPDATE_THROTTLE_MS) return

      agent.lastUpdate = receivedAt
      this.eventLastUpdates.set(sessionId, receivedAtMs)
      dirty = true
    }

    const toolPart = extractToolPart(input.event.properties)
    if (toolPart) {
      const counted = this.countedToolParts.get(sessionId) ?? new Set<string>()
      if (!toolPart.id || !counted.has(toolPart.id)) {
        agent.toolCalls += 1
        if (toolPart.id) counted.add(toolPart.id)
        this.countedToolParts.set(sessionId, counted)
        markUpdated(true)
        dirty = true
      }
    }

    if (
      input.event.type === "message.part.updated" &&
      toolPart?.tool === "question" &&
      (toolPart.status === "pending" || toolPart.status === "running")
    ) {
      const existing = agent.pendingQuestion
      const question = {
        id: toolPart.id ?? toolPart.callId,
        questions: extractQuestions(toolPart.input),
        sessionId,
        tool: toolPart.tool,
      }

      agent.pendingQuestion = question
      agent.status = "blocked"
      state.status = "blocked"
      agent.error = "Question is waiting for an answer."
      markUpdated(true)
      dirty = true

      if (!existing) {
        await this.notify(
          state,
          questionWaitText({
            agent: mapping.agent,
            pr: runLabel(state),
            question,
          }),
          { reply: true },
        )
      }
    }

    if (
      input.event.type === "permission.asked" ||
      input.event.type === "permission.updated"
    ) {
      const permission = extractPermissionRequest(input.event.properties)
      const notified = this.notifiedPermissions.get(sessionId) ?? new Set()
      const permissionId = permission?.id ?? `${mapping.agent}:${Date.now()}`

      if (!notified.has(permissionId)) {
        notified.add(permissionId)
        this.notifiedPermissions.set(sessionId, notified)
        agent.pendingPermission = permission
        agent.status = "blocked"
        state.status = "blocked"
        agent.error = `Permission ${permission?.permission ?? "request"} is waiting for approval.`
        markUpdated(true)
        dirty = true
        await this.notify(
          state,
          `Magi ${mapping.agent} is waiting for permission on ${runLabel(state)}: ${agent.error}`,
          { reply: true },
        )
      }
    }

    if (input.event.type === "question.asked") {
      const question = extractQuestionRequest(input.event.properties)
      const notified = this.notifiedPermissions.get(sessionId) ?? new Set()
      const questionId = question?.id ?? `${mapping.agent}:${Date.now()}`

      if (agent.pendingQuestion) {
        agent.pendingQuestion = question
        markUpdated(true)
        dirty = true
      } else if (!notified.has(questionId)) {
        notified.add(questionId)
        this.notifiedPermissions.set(sessionId, notified)
        agent.pendingQuestion = question
        agent.status = "blocked"
        state.status = "blocked"
        agent.error = "Question is waiting for an answer."
        markUpdated(true)
        dirty = true
        await this.notify(
          state,
          questionWaitText({
            agent: mapping.agent,
            pr: runLabel(state),
            question,
          }),
          { reply: true },
        )
      }
    }

    if (
      (input.event.type === "permission.replied" ||
        input.event.type === "permission.rejected") &&
      agent.pendingPermission
    ) {
      agent.pendingPermission = undefined
      if (!agent.pendingQuestion && agent.status === "blocked") {
        agent.status = "running"
      }
      if (state.status === "blocked" && !this.hasBlockedAgents(state)) {
        state.status = "running"
      }
      markUpdated(true)
      dirty = true
    }

    if (
      (input.event.type === "question.replied" ||
        input.event.type === "question.rejected") &&
      agent.pendingQuestion
    ) {
      agent.pendingQuestion = undefined
      if (!agent.pendingPermission && agent.status === "blocked") {
        agent.status = "running"
      }
      if (state.status === "blocked" && !this.hasBlockedAgents(state)) {
        state.status = "running"
      }
      markUpdated(true)
      dirty = true
    }

    if (
      input.event.type === "message.part.updated" &&
      toolPart?.tool === "question" &&
      (toolPart.status === "completed" || toolPart.status === "error") &&
      agent.pendingQuestion?.tool === "question"
    ) {
      agent.pendingQuestion = undefined
      if (!agent.pendingPermission && agent.status === "blocked") {
        agent.status = "running"
      }
      if (state.status === "blocked" && !this.hasBlockedAgents(state)) {
        state.status = "running"
      }
      markUpdated(true)
      dirty = true
    }

    if (
      input.event.type === "permission.replied" &&
      agent.status === "blocked"
    ) {
      agent.status = "running"
      markUpdated(true)
      dirty = true
    }

    if (input.event.type === "session.error") {
      agent.status = "failed"
      agent.error = redactSecrets(
        JSON.stringify(input.event.properties?.error ?? "session error"),
      )
      markUpdated(true)
      dirty = true
    }

    if (!dirty) markUpdated()
    if (dirty) await this.persist(state)
  }

  formatStates(
    states: MagiRunState[],
    options: { verbose?: boolean } = {},
  ): string {
    if (!states.length) return "No Magi runs found."

    return states
      .map((state) => {
        const editorLine = state.editor
          ? this.formatAgentLine("editor", state.editor, options)
          : undefined
        const triageCreatorLine = state.triageCreator
          ? this.formatAgentLine("triageCreator", state.triageCreator, options)
          : undefined
        const reviewerLines = Object.entries(state.reviewers).map(
          ([key, reviewer]) => {
            return this.formatAgentLine(key, reviewer, options)
          },
        )
        const classifierLines = Object.entries(state.ciClassifiers ?? {}).map(
          ([key, classifier]) =>
            this.formatAgentLine(`ci:${key}`, classifier, options),
        )
        const lines = [
          options.verbose ? `Run: ${state.runId}` : undefined,
          state.pr == null ? undefined : `PR: #${state.pr}`,
          state.issue == null ? undefined : `Issue: #${state.issue}`,
          `Command: ${state.command}`,
          state.dryRun ? "Dry run: true" : undefined,
          `Status: ${state.status}`,
          `Phase: ${state.phase}`,
          state.verdict ? `Verdict: ${state.verdict}` : undefined,
          state.error ? `Error: ${state.error}` : undefined,
          ...(state.ciReports ?? []).flatMap((report) => [
            ...report.scopeOutsideRecovered.map(
              (item) =>
                `CI scope outside recovered: ${item.check.name}${report.attempts ? ` (recovered after ${report.attempts} retry attempt${report.attempts === 1 ? "" : "s"})` : ""} - ${item.reason}`,
            ),
            ...report.scopeOutsideUnresolved.map(
              (item) =>
                `CI scope outside unresolved: ${item.check.name}${report.attempts ? ` (${report.attempts} retry attempt${report.attempts === 1 ? "" : "s"})` : ""} - ${item.reason}`,
            ),
            ...report.scopeInside.map(
              (item) => `CI scope inside: ${item.check.name} - ${item.reason}`,
            ),
          ]),
          ...(state.warnings ?? []).map((warning) => `Warning: ${warning}`),
          options.verbose && state.threadAttempts
            ? `Thread attempts: ${Object.keys(state.threadAttempts).length} tracked, ${Object.values(state.threadAttempts).filter((attempt) => attempt.exhaustedAtCycle != null).length} exhausted`
            : undefined,
          options.verbose ? `Artifacts: ${state.outputDir}` : undefined,
          options.verbose && state.reportPath
            ? `Report: ${state.reportPath}`
            : undefined,
          editorLine,
          triageCreatorLine,
          ...classifierLines,
          ...reviewerLines,
        ]
        return lines.filter(Boolean).join("\n")
      })
      .join("\n\n")
  }

  async formatStatesWithReports(
    states: MagiRunState[],
    options: { verbose?: boolean } = {},
  ): Promise<string> {
    const sections = [this.formatStates(states, options)]

    if (!options.verbose) return sections[0]

    for (const state of states) {
      if (state.status !== "completed" || !state.reportPath) continue

      const report = await readFile(state.reportPath, "utf8").catch(
        () => "(missing report artifact)",
      )

      sections.push(
        [
          `Report for ${runLabel(state)} (${state.runId}):`,
          "",
          report.trimEnd(),
        ].join("\n"),
      )
    }

    return sections.join("\n\n")
  }

  private collectSessionIds(state: MagiRunState): string[] {
    const ids = [
      state.editor?.sessionId,
      state.triageCreator?.sessionId,
      ...Object.values(state.reviewers).map((reviewer) => reviewer.sessionId),
      ...Object.values(state.ciClassifiers ?? {}).map(
        (classifier) => classifier.sessionId,
      ),
      ...Object.values(state.sessionIds ?? {}),
      ...(state.ciReports ?? []).flatMap((report) =>
        (report.classifierRuns ?? []).map((run) => run.sessionId),
      ),
    ].filter((id): id is string => Boolean(id))

    return [...new Set(ids)]
  }

  private formatClearSummary(
    summary: MagiClearSummary,
    lines: string[],
  ): string {
    return [
      `Cleared Magi runs: ${summary.runsCleared}`,
      `Skipped active runs: ${summary.runsSkippedActive}`,
      `Sessions deleted: ${summary.sessionDeleted}${summary.sessionFailed ? ` (${summary.sessionFailed} failed)` : ""}`,
      `Worktrees deleted: ${summary.worktreeDeleted}${summary.worktreeFailed ? ` (${summary.worktreeFailed} failed)` : ""}`,
      `Branches deleted: ${summary.branchDeleted}${summary.branchFailed ? ` (${summary.branchFailed} failed)` : ""}${summary.branchSkipped ? `, ${summary.branchSkipped} skipped` : ""}`,
      `Outputs deleted: ${summary.outputDeleted}${summary.outputFailed ? ` (${summary.outputFailed} failed)` : ""}`,
      ...lines.map((line) => `- ${line}`),
    ].join("\n")
  }

  private formatAgentLine(
    key: string,
    agent: MagiRunAgentState,
    options: { verbose?: boolean },
  ): string {
    const details = [
      agent.verdict,
      options.verbose && agent.sessionId
        ? `session=${agent.sessionId}`
        : undefined,
      options.verbose && agent.toolCalls
        ? `tools=${agent.toolCalls}`
        : undefined,
      options.verbose && agent.repairAttempts
        ? `repairs=${agent.repairAttempts}`
        : undefined,
      options.verbose && agent.pendingPermission
        ? `pendingPermission=${agent.pendingPermission.id ?? agent.pendingPermission.permission ?? "unknown"}`
        : undefined,
      options.verbose && agent.pendingQuestion
        ? `pendingQuestion=${agent.pendingQuestion.id ?? "unknown"}`
        : undefined,
    ].filter(Boolean)
    return `- ${key}: ${agent.status}${details.length ? ` (${details.join(", ")})` : ""}`
  }

  private agentState(
    state: MagiRunState,
    key: string,
  ): MagiRunAgentState | undefined {
    if (key.startsWith("ci:")) return state.ciClassifiers?.[key.slice(3)]
    if (key === "editor") return state.editor
    if (key === "triageCreator") return state.triageCreator
    return state.reviewers[key]
  }

  private agentEntries(state: MagiRunState): [string, MagiRunAgentState][] {
    return [
      ...(state.editor
        ? [["editor", state.editor] as [string, MagiRunAgentState]]
        : []),
      ...(state.triageCreator
        ? [
            ["triageCreator", state.triageCreator] as [
              string,
              MagiRunAgentState,
            ],
          ]
        : []),
      ...Object.entries(state.ciClassifiers ?? {}).map(
        ([key, value]) => [`ci:${key}`, value] as [string, MagiRunAgentState],
      ),
      ...Object.entries(state.reviewers),
    ]
  }

  private selectPendingAgent(
    state: MagiRunState,
    kind: "permission" | "question",
    key?: string,
    requestId?: string,
  ): { key: string; state: MagiRunAgentState } | string {
    const entries = key
      ? this.agentState(state, key)
        ? [[key, this.agentState(state, key)] as [string, MagiRunAgentState]]
        : []
      : this.agentEntries(state)
    const matches = entries.filter(([, agent]) => {
      const pending =
        kind === "permission" ? agent.pendingPermission : agent.pendingQuestion

      if (!pending) return false
      return !requestId || pending.id === requestId
    })

    if (!matches.length) {
      return key
        ? `No pending ${kind} request found for ${key}.`
        : `No pending ${kind} request found for ${runLabel(state)}.`
    }
    if (matches.length > 1) {
      return `Multiple pending ${kind} requests found for ${runLabel(state)}. Specify agent or requestId.`
    }

    return { key: matches[0][0], state: matches[0][1] }
  }

  private hasBlockedAgents(state: MagiRunState): boolean {
    return this.agentEntries(state).some(
      ([, agent]) => agent.status === "blocked",
    )
  }

  private async executeSync(
    state: MagiRunState,
    controller: AbortController,
    execute: () => Promise<void>,
    timeoutMs?: number,
  ): Promise<MagiRunState> {
    let timeout: ReturnType<typeof setTimeout> | undefined
    const timeoutPromise =
      timeoutMs == null
        ? undefined
        : new Promise<"timeout">((resolve) => {
            timeout = setTimeout(() => resolve("timeout"), timeoutMs)
          })

    try {
      const result = await (timeoutPromise
        ? Promise.race([
            execute().then(() => "completed" as const),
            timeoutPromise,
          ])
        : execute().then(() => "completed" as const))
      if (result === "timeout") {
        const timeoutSeconds = (timeoutMs ?? 0) / 1_000
        controller.abort()
        await this.failRun(
          state.runId,
          new Error(`Magi sync run timed out after ${timeoutSeconds} seconds.`),
        )
      }
    } catch (error) {
      controller.abort()
      await this.failRun(state.runId, error)
    } finally {
      if (timeout) clearTimeout(timeout)
    }

    return (await this.readStateByRunId(state.runId)) ?? state
  }

  private assertSuccessfulSyncFollowUp(state: MagiRunState): void {
    if (state.status === "completed") return

    throw new Error(
      `Synchronous follow-up ${state.command} run ${state.runId} finished with status ${state.status}.`,
    )
  }

  private async executeReview(input: {
    config: MagiConfig
    dryRun?: boolean
    parentSessionId?: string
    pr: number
    repository: ResolvedRepository
    runId: string
    signal?: AbortSignal
  }): Promise<void> {
    const result = await runReview({
      approvalPolicy: input.repository.merge.approvalPolicy,
      client: this.input.client,
      config: input.config,
      directory: this.input.directory,
      dryRun: input.dryRun,
      exec: withGitHubApiRetry(
        this.input.exec,
        input.config.github?.apiRetryAttempts ?? 3,
      ),
      onProgress: (progress) => this.applyReviewProgress(input.runId, progress),
      parentSessionId: input.parentSessionId,
      pr: input.pr,
      repository: input.repository,
      runId: input.runId,
      signal: input.signal,
    })

    const state = this.active.get(input.runId)
    if (!state) return
    if (state.status === "cancelled") return

    state.status = "completed"
    state.phase = "completed"
    state.completedAt = now()
    state.verdict = result.verdict
    state.majority = result.verdict
    state.posted = result.posted
    state.reportPath = join(state.outputDir, "report.md")
    state.sessionIds = result.sessionIds

    for (const [key, output] of Object.entries(result.outputs)) {
      const reviewer = state.reviewers[key]
      if (!reviewer) continue
      reviewer.status = "completed"
      reviewer.verdict = output.verdict
      const artifact =
        "resolve" in output
          ? reviewerArtifactBase("rereview", key)
          : reviewerArtifactBase("review", key)
      reviewer.rawPath = join(state.outputDir, `${artifact}.raw.txt`)
      reviewer.parsedPath = join(state.outputDir, `${artifact}.json`)
    }
    for (const [key, posted] of Object.entries(result.posted)) {
      const reviewer = state.reviewers[key]
      if (!reviewer || !posted.startsWith("skipped:")) continue
      reviewer.status = "skipped"
    }

    await this.persist(state)
    if (result.worktreePath) {
      await removeWorktree(this.input.exec, result.worktreePath).catch(
        () => undefined,
      )
    }
    if (state.worktreeBranch) {
      await removeBranch(this.input.exec, state.worktreeBranch).catch(
        () => undefined,
      )
    }
    await this.notify(
      state,
      [`Finished reviewing ${prMarkdownLink(state)}.`, "", result.report].join(
        "\n",
      ),
      { reply: true },
    )
    this.active.delete(input.runId)
    this.controllers.delete(input.runId)
  }

  private async executeMerge(input: {
    config: MagiConfig
    dryRun?: boolean
    parentSessionId?: string
    pr: number
    repository: ResolvedRepository
    runId: string
    signal?: AbortSignal
  }): Promise<void> {
    const result = await runMerge({
      client: this.input.client,
      config: input.config,
      directory: this.input.directory,
      dryRun: input.dryRun,
      exec: withGitHubApiRetry(
        this.input.exec,
        input.config.github?.apiRetryAttempts ?? 3,
      ),
      onProgress: (progress) => this.applyMergeProgress(input.runId, progress),
      parentSessionId: input.parentSessionId,
      pr: input.pr,
      repository: input.repository,
      runId: input.runId,
      signal: input.signal,
    })

    const state = this.active.get(input.runId)
    if (!state) return
    if (state.status === "cancelled") return

    state.status = "completed"
    state.phase = result.status
    state.completedAt = now()
    state.verdict = result.status
    state.reportPath = join(state.outputDir, "report.md")
    if (state.editor?.status === "pending") state.editor.status = "skipped"

    await this.persist(state)
    await this.notify(
      state,
      [
        `Finished merge workflow for ${prMarkdownLink(state)}.`,
        "",
        result.report,
      ].join("\n"),
      { reply: true },
    )
    this.active.delete(input.runId)
    this.controllers.delete(input.runId)
  }

  private async executeTriage(input: {
    config: MagiConfig
    dryRun?: boolean
    issue: number
    parentSessionId?: string
    repository: ResolvedRepository
    runId: string
    signal?: AbortSignal
    sync?: boolean
    timeoutMs?: number
  }): Promise<void> {
    const state = this.active.get(input.runId)
    if (state) {
      state.status = "running"
      state.phase = "triaging"
      await this.persist(state)
    }

    const result = await runTriage({
      client: this.input.client,
      config: input.config,
      directory: this.input.directory,
      dryRun: input.dryRun,
      exec: withGitHubApiRetry(
        this.input.exec,
        input.config.github?.apiRetryAttempts ?? 3,
      ),
      issue: input.issue,
      onProgress: (progress) => this.applyTriageProgress(input.runId, progress),
      parentSessionId: input.parentSessionId,
      repository: input.repository,
      runId: input.runId,
      signal: input.signal,
    })

    const completed = this.active.get(input.runId)
    if (!completed || completed.status === "cancelled") return

    const triageResult = JSON.stringify(result.result)
    completed.status =
      result.result.disposition === "failed" ? "failed" : "completed"
    completed.phase = triageResult
    completed.completedAt = now()
    completed.verdict = triageResult
    completed.reportPath = join(completed.outputDir, "report.md")
    for (const agent of Object.values(completed.reviewers)) {
      if (agent.status === "pending") agent.status = "completed"
    }
    if (completed.triageCreator?.status === "pending") {
      completed.triageCreator.status = "skipped"
    }

    await this.persist(completed)
    await this.notify(
      completed,
      [
        `Finished triage for ${issueMarkdownLink(completed)}.`,
        "",
        result.report,
      ].join("\n"),
      { reply: true },
    )

    const followUpPr = result.prUrl
      ? pullRequestNumberFromUrl(result.prUrl)
      : undefined
    const triageAutomation = input.repository.triage?.automation
    if (followUpPr != null && triageAutomation?.merge) {
      const followUp = await this.startMerge({
        config: input.config,
        dryRun: input.dryRun,
        parentSessionId: input.parentSessionId,
        pr: followUpPr,
        repository: input.repository,
        signal: input.signal,
        sync: input.sync,
        timeoutMs: input.timeoutMs,
      })
      if (input.sync) this.assertSuccessfulSyncFollowUp(followUp)
    } else if (followUpPr != null && triageAutomation?.review) {
      const followUp = await this.startReview({
        config: input.config,
        dryRun: input.dryRun,
        parentSessionId: input.parentSessionId,
        pr: followUpPr,
        repository: input.repository,
        signal: input.signal,
        sync: input.sync,
        timeoutMs: input.timeoutMs,
      })
      if (input.sync) this.assertSuccessfulSyncFollowUp(followUp)
    }
    this.active.delete(input.runId)
    this.controllers.delete(input.runId)
  }

  private async applyTriageProgress(
    runId: string,
    progress: TriageRunProgress,
  ): Promise<void> {
    const state = this.active.get(runId)
    if (!state) return

    const issue = issueMarkdownLink(state)
    const creatorState = () =>
      state.triageCreator ??
      (state.triageCreator = {
        account: "triageCreator",
        repairAttempts: 0,
        status: "pending",
        toolCalls: 0,
      })

    state.updatedAt = now()

    if (progress.type === "phase") {
      state.phase = progress.phase
      state.status = "running"
    }

    if (progress.type === "decision") {
      state.phase = `decision: ${progress.result.disposition}`
      state.verdict = JSON.stringify(progress.result)
    }

    if (progress.type === "comment_posting") {
      state.phase = "posting triage comment"
      state.status = "posting"
    }

    if (progress.type === "comment_posted") {
      state.status = "running"
    }

    if (progress.type === "pr_creation_started") {
      state.phase = "creating implementation PR"
      state.status = "running"
    }

    if (progress.type === "worktree_created") {
      state.worktreePath = progress.worktreePath
      state.worktreeBranch = progress.branch
    }

    if (progress.type === "triage_agent_started") {
      const voter = state.reviewers[progress.voter]
      if (voter) voter.status = "running"
    }

    if (progress.type === "triage_agent_session") {
      const voter = state.reviewers[progress.voter]
      if (voter) {
        if (progress.options)
          this.input.setSessionOptions?.(progress.sessionId, progress.options)
        voter.sessionId = progress.sessionId
        voter.status = "running"
        voter.lastUpdate = now()
        this.sessionToRun.set(progress.sessionId, {
          agent: progress.voter,
          runId,
        })
      }
    }

    if (progress.type === "triage_agent_repair") {
      const voter = state.reviewers[progress.voter]
      if (voter) {
        voter.status = "repairing"
        voter.repairAttempts += 1
        voter.lastUpdate = now()
      }
    }

    if (progress.type === "triage_agent_response") {
      const voter = state.reviewers[progress.voter]
      if (voter) {
        voter.sessionId = progress.sessionId
        voter.lastUpdate = now()
      }
    }

    if (progress.type === "triage_agent_completed") {
      const voter = state.reviewers[progress.voter]
      if (voter) {
        voter.sessionId = progress.sessionId
        voter.status = "completed"
        voter.verdict = progress.vote
        voter.rawPath = join(
          state.outputDir,
          `${progress.voter}.${progress.phase}.raw.txt`,
        )
        voter.parsedPath = join(
          state.outputDir,
          `${progress.voter}.${progress.phase}.json`,
        )
        voter.lastUpdate = now()
      }
    }

    if (progress.type === "triage_agent_failed") {
      const voter = state.reviewers[progress.voter]
      if (voter) {
        voter.status = "failed"
        voter.error = redactSecrets(progress.error)
        voter.lastUpdate = now()
      }
    }

    if (progress.type === "triage_creator_started") {
      creatorState().status = "running"
    }

    if (progress.type === "triage_creator_session") {
      const creator = creatorState()
      if (progress.options)
        this.input.setSessionOptions?.(progress.sessionId, progress.options)
      creator.sessionId = progress.sessionId
      creator.status = "running"
      creator.lastUpdate = now()
      this.sessionToRun.set(progress.sessionId, {
        agent: "triageCreator",
        runId,
      })
    }

    if (progress.type === "triage_creator_repair") {
      const creator = creatorState()
      creator.status = "repairing"
      creator.repairAttempts += 1
      creator.lastUpdate = now()
    }

    if (progress.type === "triage_creator_response") {
      const creator = creatorState()
      creator.sessionId = progress.sessionId
      creator.lastUpdate = now()
    }

    if (progress.type === "triage_creator_completed") {
      const creator = creatorState()
      creator.sessionId = progress.sessionId
      creator.status = "completed"
      creator.parsedPath = join(state.outputDir, "create-pr.json")
      creator.lastUpdate = now()
    }

    if (progress.type === "triage_creator_failed") {
      const creator = creatorState()
      creator.status = "failed"
      creator.error = redactSecrets(progress.error)
      creator.lastUpdate = now()
    }

    await this.persist(state)

    if (progress.type === "phase") {
      await this.notify(state, `Triage phase for ${issue}: ${progress.phase}.`)
    }

    if (progress.type === "decision") {
      await this.notify(
        state,
        triageDecisionNotification({
          action: progress.action,
          issue,
          result: JSON.stringify(progress.result),
        }),
      )
    }

    if (progress.type === "triage_agent_started") {
      await this.notify(
        state,
        `**Triage agent ${progress.voter}** started ${progress.phase} for ${issue}.`,
      )
    }

    if (progress.type === "triage_agent_repair") {
      await this.notify(
        state,
        `**Triage agent ${progress.voter}** started JSON regeneration for ${issue}.`,
      )
    }

    if (progress.type === "triage_agent_completed") {
      await this.notify(
        state,
        `**Triage agent ${progress.voter}** completed ${progress.phase} for ${issue}: ${progress.vote}.`,
      )
    }

    if (progress.type === "triage_agent_failed") {
      await this.notify(
        state,
        `**Triage agent ${progress.voter}** failed ${progress.phase} for ${issue}: ${redactSecrets(progress.error)}`,
      )
    }

    if (progress.type === "comment_posting") {
      await this.notify(state, `Posting triage comment for ${issue}.`)
    }

    if (progress.type === "comment_posted") {
      await this.notify(
        state,
        `Posted triage comment for ${issue}: ${progress.url}`,
      )
    }

    if (progress.type === "pr_creation_started") {
      await this.notify(
        state,
        `Started implementation PR creation for ${issue}.`,
      )
    }

    if (progress.type === "worktree_created") {
      await this.notify(state, `Worktree is ready for ${issue}.`)
    }

    if (progress.type === "triage_creator_started") {
      await this.notify(
        state,
        `**Triage creator** started creating an implementation PR for ${issue}.`,
      )
    }

    if (progress.type === "triage_creator_repair") {
      await this.notify(
        state,
        `**Triage creator** started JSON regeneration for ${issue}.`,
      )
    }

    if (progress.type === "triage_creator_completed") {
      await this.notify(
        state,
        `**Triage creator** completed implementation changes for ${issue}.`,
      )
    }

    if (progress.type === "triage_creator_failed") {
      await this.notify(
        state,
        triageCreatorFailureText({
          error: redactSecrets(progress.error),
          issue,
          repairAttempts: state.triageCreator?.repairAttempts ?? 0,
        }),
      )
    }

    if (progress.type === "pr_created") {
      await this.notify(
        state,
        `Created implementation PR for ${issue}: ${progress.url}`,
      )
    }
  }

  private async applyReviewProgress(
    runId: string,
    progress: ReviewRunProgress,
  ): Promise<void> {
    const state = this.active.get(runId)
    if (!state) return

    state.updatedAt = now()

    if (progress.type === "phase") {
      state.phase = progress.phase
      state.status =
        progress.phase === "posting reviews" ? "posting" : "running"
    }

    if (progress.type === "ci_report") {
      state.ciReports = [...(state.ciReports ?? []), progress.report]
    }

    if (progress.type === "ci_classifier_started") {
      state.ciClassifiers ??= {}
      state.ciClassifiers[progress.reviewer] = {
        account: progress.reviewer,
        promptPath: progress.promptPath,
        repairAttempts: 0,
        status: "running",
        toolCalls: 0,
      }
    }

    if (progress.type === "ci_classifier_session") {
      state.ciClassifiers ??= {}
      const classifier =
        state.ciClassifiers[progress.reviewer] ??
        (state.ciClassifiers[progress.reviewer] = {
          account: progress.reviewer,
          repairAttempts: 0,
          status: "running",
          toolCalls: 0,
        })
      classifier.sessionId = progress.sessionId
      classifier.status = "running"
      classifier.lastUpdate = now()
      this.sessionToRun.set(progress.sessionId, {
        agent: `ci:${progress.reviewer}`,
        runId,
      })
    }

    if (progress.type === "ci_classifier_repair") {
      const classifier = state.ciClassifiers?.[progress.reviewer]
      if (classifier) {
        classifier.repairAttempts += 1
        classifier.status = "repairing"
        classifier.lastUpdate = now()
      }
    }

    if (progress.type === "ci_classifier_completed") {
      const classifier = state.ciClassifiers?.[progress.reviewer]
      if (classifier) {
        classifier.classification = progress.classification
        classifier.rawPath = progress.rawPath
        classifier.reason = progress.reason
        classifier.sessionId = progress.sessionId
        classifier.status = "completed"
        classifier.lastUpdate = now()
      }
    }

    if (progress.type === "ci_classifier_failed") {
      const classifier = state.ciClassifiers?.[progress.reviewer]
      if (classifier) {
        classifier.error = redactSecrets(progress.error)
        classifier.status = "failed"
        classifier.lastUpdate = now()
      }
    }

    if (progress.type === "worktree_created") {
      state.worktreePath = progress.worktreePath
      state.worktreeBranch = progress.branch
    }

    if (progress.type === "reviewer_started") {
      const reviewer = state.reviewers[progress.reviewer]
      if (!reviewer) return
      reviewer.status = "running"
    }

    if (progress.type === "reviewer_skipped") {
      const reviewer = state.reviewers[progress.reviewer]
      if (!reviewer) return
      reviewer.status = "skipped"
      reviewer.verdict = progress.verdict
    }

    if (progress.type === "reviewer_session") {
      const reviewer = state.reviewers[progress.reviewer]
      if (!reviewer) return
      if (progress.options)
        this.input.setSessionOptions?.(progress.sessionId, progress.options)
      reviewer.sessionId = progress.sessionId
      reviewer.status = "running"
      reviewer.lastUpdate = now()
      this.sessionToRun.set(progress.sessionId, {
        agent: progress.reviewer,
        runId,
      })
    }

    if (progress.type === "reviewer_repair") {
      const reviewer = state.reviewers[progress.reviewer]
      if (!reviewer) return
      reviewer.status = "repairing"
      reviewer.repairAttempts += 1
      reviewer.lastUpdate = now()
    }

    if (progress.type === "reviewer_response") {
      const reviewer = state.reviewers[progress.reviewer]
      if (!reviewer) return
      reviewer.sessionId = progress.sessionId
      reviewer.lastUpdate = now()
    }

    if (progress.type === "reviewer_failed") {
      const reviewer = state.reviewers[progress.reviewer]
      if (!reviewer) return
      reviewer.status = "failed"
      reviewer.error = redactSecrets(progress.error)
      reviewer.lastUpdate = now()
    }

    if (progress.type === "reviewer_completed") {
      const reviewer = state.reviewers[progress.reviewer]
      if (!reviewer) return
      reviewer.sessionId = progress.sessionId
      reviewer.status = "completed"
      reviewer.verdict = progress.verdict
      reviewer.lastUpdate = now()
    }

    if (progress.type === "completed") {
      state.verdict = progress.verdict
    }

    await this.persist(state)

    if (progress.type === "reviewer_reconsidered") {
      await this.notify(
        state,
        closeReconsiderationText({
          pr: prMarkdownLink(state),
          reviewer: progress.reviewer,
          to: progress.to,
        }),
      )
    }

    if (progress.type === "findings_validated") {
      await this.notify(
        state,
        findingsValidationText({
          discarded: progress.discarded,
          kept: progress.kept,
          pr: prMarkdownLink(state),
        }),
      )
      for (const reviewer of progress.reviewersChangedToMerge) {
        await this.notify(
          state,
          `**Reviewer ${reviewer}** had no remaining findings after validation and approved ${prMarkdownLink(state)}.`,
        )
      }
    }

    if (progress.type === "ci_report") {
      await this.notify(
        state,
        ciReportText({ pr: prMarkdownLink(state), report: progress.report }),
      )
    }

    if (progress.type === "ci_classifier_started") {
      await this.notify(
        state,
        `**CI classifier ${progress.reviewer}** started for ${prMarkdownLink(state)}.`,
      )
    }

    if (progress.type === "ci_classifier_repair") {
      await this.notify(
        state,
        `**CI classifier ${progress.reviewer}** started JSON regeneration for ${prMarkdownLink(state)}.`,
      )
    }

    if (progress.type === "ci_classifier_completed") {
      await this.notify(
        state,
        `**CI classifier ${progress.reviewer}** completed for ${prMarkdownLink(state)}: ${progress.classification} - ${progress.reason}`,
      )
    }

    if (progress.type === "ci_classifier_failed") {
      await this.notify(
        state,
        `**CI classifier ${progress.reviewer}** failed for ${prMarkdownLink(state)}: ${redactSecrets(progress.error)}`,
      )
    }

    if (progress.type === "worktree_created") {
      await this.notify(
        state,
        `Worktree is ready for ${prMarkdownLink(state)}.`,
      )
    }

    if (progress.type === "reviewer_started") {
      await this.notify(
        state,
        `**Reviewer ${progress.reviewer}** started reviewing ${prMarkdownLink(state)}.`,
      )
    }

    if (progress.type === "reviewer_skipped") {
      await this.notify(
        state,
        `**Reviewer ${progress.reviewer}** skipped ${prMarkdownLink(state)} with existing verdict ${progress.verdict}.`,
      )
    }

    if (progress.type === "reviewer_repair") {
      await this.notify(
        state,
        `**Reviewer ${progress.reviewer}** started JSON regeneration for ${prMarkdownLink(state)}.`,
      )
    }

    if (progress.type === "reviewer_failed") {
      await this.notify(
        state,
        reviewerFailureText({
          error: redactSecrets(progress.error),
          pr: prMarkdownLink(state),
          repairAttempts:
            state.reviewers[progress.reviewer]?.repairAttempts ?? 0,
          reviewer: progress.reviewer,
        }),
      )
    }

    if (progress.type === "phase" && state.command === "review") {
      const text = mergePhaseText({
        phase: progress.phase,
        pr: prMarkdownLink(state),
      })

      if (text) await this.notify(state, text)
    }

    if (progress.type === "completed" && state.command === "merge") {
      await this.notify(
        state,
        reviewDecisionText({
          pr: prMarkdownLink(state),
          verdict: progress.verdict,
        }),
      )
    }

    if (progress.type === "completed" && state.command === "review") {
      await this.notify(
        state,
        reviewDecisionText({
          pr: prMarkdownLink(state),
          verdict: progress.verdict,
        }),
      )
    }

    if (progress.type === "reviewer_completed") {
      await this.notify(
        state,
        reviewerCompletionText({
          pr: prMarkdownLink(state),
          reviewer: progress.reviewer,
          verdict: progress.verdict,
        }),
      )
    }
  }

  private async applyMergeProgress(
    runId: string,
    progress: MergeRunProgress,
  ): Promise<void> {
    if (
      progress.type === "phase" ||
      progress.type === "worktree_created" ||
      progress.type === "reviewer_started" ||
      progress.type === "reviewer_skipped" ||
      progress.type === "reviewer_session" ||
      progress.type === "reviewer_repair" ||
      progress.type === "reviewer_response" ||
      progress.type === "reviewer_failed" ||
      progress.type === "reviewer_completed" ||
      progress.type === "reviewer_reconsidered" ||
      progress.type === "findings_validated" ||
      progress.type === "ci_report" ||
      progress.type === "completed"
    ) {
      if (progress.type === "phase") {
        const state = this.active.get(runId)
        const text = state
          ? mergePhaseText({ phase: progress.phase, pr: prMarkdownLink(state) })
          : undefined

        if (state && text) await this.notify(state, text)
      }
      await this.applyReviewProgress(runId, progress)
      return
    }

    const state = this.active.get(runId)
    if (!state) return

    if (progress.type === "warning") {
      state.warnings = [...(state.warnings ?? []), progress.message]
      await this.persist(state)
      await this.notify(
        state,
        `Warning for ${prMarkdownLink(state)}: ${progress.message}`,
      )
      return
    }

    if (progress.type === "thread_limit_reached") {
      await this.notify(
        state,
        threadLimitText({
          pr: prMarkdownLink(state),
          threads: progress.threads,
        }),
      )
      return
    }

    if (progress.type === "thread_attempts") {
      state.threadAttempts = progress.attempts
      await this.persist(state)
      await this.notify(
        state,
        `Tracked ${Object.keys(progress.attempts).length} review thread resolution attempts for ${prMarkdownLink(state)}.`,
      )
      return
    }

    const editor = state.editor
    if (!editor) return

    state.updatedAt = now()

    if (progress.type === "editor_started") {
      editor.status = "running"
    }

    if (progress.type === "editor_session") {
      if (progress.options)
        this.input.setSessionOptions?.(progress.sessionId, progress.options)
      editor.sessionId = progress.sessionId
      editor.status = "running"
      editor.lastUpdate = now()
      this.sessionToRun.set(progress.sessionId, { agent: "editor", runId })
    }

    if (progress.type === "editor_repair") {
      editor.status = "repairing"
      editor.repairAttempts += 1
      editor.lastUpdate = now()
    }

    if (progress.type === "editor_response") {
      editor.sessionId = progress.sessionId
      editor.lastUpdate = now()
    }

    if (progress.type === "editor_failed") {
      editor.status = "failed"
      editor.error = redactSecrets(progress.error)
      editor.lastUpdate = now()
    }

    if (progress.type === "editor_completed") {
      editor.status = "completed"
      editor.rawPath = join(
        state.outputDir,
        `editor.cycle-${progress.cycle}.raw.txt`,
      )
      editor.parsedPath = join(
        state.outputDir,
        `editor.cycle-${progress.cycle}.json`,
      )
      editor.lastUpdate = now()
    }

    if (progress.type === "merge_completed") {
      state.verdict = progress.status
    }

    await this.persist(state)

    if (progress.type === "editor_started") {
      await this.notify(
        state,
        `**Editor** started edit cycle ${progress.cycle} for ${prMarkdownLink(state)}.`,
      )
    }

    if (progress.type === "editor_repair") {
      await this.notify(
        state,
        `**Editor** started JSON regeneration for ${prMarkdownLink(state)} cycle ${progress.cycle}.`,
      )
    }

    if (progress.type === "editor_completed") {
      await this.notify(
        state,
        `**Editor** finished editing ${prMarkdownLink(state)}.`,
      )
    }

    if (progress.type === "editor_failed") {
      await this.notify(
        state,
        editorFailureText({
          error: redactSecrets(progress.error),
          pr: prMarkdownLink(state),
          repairAttempts: state.editor?.repairAttempts ?? 0,
        }),
      )
    }

    if (progress.type === "merge_completed") {
      await this.notify(
        state,
        `Merge workflow reached ${progress.status} for ${prMarkdownLink(state)}.`,
      )
    }
  }

  private async failRun(runId: string, error: unknown): Promise<void> {
    const state = this.active.get(runId)
    if (!state) return
    if (state.status === "cancelled") return

    state.status = "failed"
    state.phase = "failed"
    state.completedAt = now()
    state.error = errorMessage(error)
    if (
      state.editor?.status === "pending" ||
      state.editor?.status === "running" ||
      state.editor?.status === "repairing" ||
      state.editor?.status === "blocked"
    ) {
      state.editor.status = "failed"
      state.editor.error = state.error
    }
    if (state.editor?.sessionId) {
      await this.input.client.session
        .abort?.({ path: { id: state.editor.sessionId } })
        .catch(() => undefined)
    }
    for (const reviewer of Object.values(state.reviewers)) {
      if (
        reviewer.status === "pending" ||
        reviewer.status === "running" ||
        reviewer.status === "repairing" ||
        reviewer.status === "blocked"
      ) {
        reviewer.status = "failed"
        reviewer.error = state.error
      }
      if (reviewer.sessionId) {
        await this.input.client.session
          .abort?.({ path: { id: reviewer.sessionId } })
          .catch(() => undefined)
      }
    }
    for (const classifier of Object.values(state.ciClassifiers ?? {})) {
      if (
        classifier.status === "pending" ||
        classifier.status === "running" ||
        classifier.status === "repairing" ||
        classifier.status === "blocked"
      ) {
        classifier.status = "failed"
        classifier.error = state.error
      }
      if (classifier.sessionId) {
        await this.input.client.session
          .abort?.({ path: { id: classifier.sessionId } })
          .catch(() => undefined)
      }
    }
    await this.persist(state)
    await this.notify(
      state,
      `Magi ${state.command} failed for ${runLabel(state)}: ${state.error}`,
      { reply: true },
    )
    this.active.delete(runId)
    this.controllers.delete(runId)
  }

  private async filteredStates(input: {
    command?: MagiRunState["command"]
    issue?: number
    outputDir?: string | string[]
    pr?: NumberFilter
    runId?: string
  }): Promise<MagiRunState[]> {
    const states = input.runId
      ? (await this.readStateByRunId(input.runId))
        ? [(await this.readStateByRunId(input.runId)) as MagiRunState]
        : []
      : await this.listStates(input.outputDir)

    return states
      .filter(
        (state) => input.command == null || state.command === input.command,
      )
      .filter((state) => input.issue == null || state.issue === input.issue)
      .filter((state) => matchesNumberFilter(state.pr, input.pr))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  private async selectState(input: {
    command?: MagiRunState["command"]
    issue?: number
    outputDir?: string | string[]
    pr?: number
    runId?: string
  }): Promise<MagiRunState | undefined> {
    if (input.runId) return this.readStateByRunId(input.runId)

    return (await this.filteredStates(input))[0]
  }

  private selectorText(input: {
    issue?: number
    pr?: number
    runId?: string
  }): string {
    if (input.runId) return input.runId
    if (input.pr != null) return `PR #${input.pr}`
    if (input.issue != null) return `issue #${input.issue}`

    return "all runs"
  }

  private absoluteOutputDir(dir: string): string {
    return isAbsolute(dir) ? dir : join(this.input.directory, dir)
  }

  private absoluteWorktreeDirs(input: {
    worktreeDir?: string | string[]
  }): string[] {
    const worktreeDirs = Array.isArray(input.worktreeDir)
      ? input.worktreeDir
      : input.worktreeDir
        ? [input.worktreeDir]
        : worktreeBaseDirs(this.input.directory)

    return worktreeDirs.map((dir) =>
      isAbsolute(dir) ? dir : join(this.input.directory, dir),
    )
  }

  private emptyOutputCleanupRoots(input: {
    outputDir?: string | string[]
  }): string[] {
    const outputDirs = Array.isArray(input.outputDir)
      ? input.outputDir
      : input.outputDir
        ? [input.outputDir]
        : [join(this.input.directory, ".magi", "runs")]

    return outputDirs.map((dir) => this.absoluteOutputDir(dir))
  }

  private async pruneEmptyMagiDirectories(input: {
    dirs: Iterable<string>
    trees: Iterable<string>
  }): Promise<void> {
    for (const dir of input.trees) {
      await pruneEmptyDirectories({
        boundary: this.input.directory,
        recursive: true,
        start: dir,
      })
    }
    for (const dir of input.dirs) {
      await pruneEmptyDirectories({
        boundary: this.input.directory,
        start: dir,
      })
    }
  }

  private async listStates(
    outputDir?: string | string[],
  ): Promise<MagiRunState[]> {
    for (const dir of Array.isArray(outputDir)
      ? outputDir
      : outputDir
        ? [outputDir]
        : []) {
      this.outputDirs.add(this.absoluteOutputDir(dir))
    }
    const baseDirs = [...this.outputDirs].map((dir) =>
      this.absoluteOutputDir(dir),
    )
    if (!baseDirs.length)
      baseDirs.push(join(this.input.directory, ".magi", "runs"))
    const states: MagiRunState[] = []

    async function walk(dir: string): Promise<void> {
      const entries = await readdir(dir, { withFileTypes: true }).catch(
        () => [],
      )
      for (const entry of entries) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) {
          await walk(path)
          continue
        }
        if (entry.name !== "state.json") continue
        const state = await readFile(path, "utf8")
          .then((text) => JSON.parse(text) as MagiRunState)
          .catch(() => undefined)
        if (state) states.push(state)
      }
    }

    for (const baseDir of baseDirs) await walk(baseDir)
    for (const state of this.active.values()) {
      if (!states.some((item) => item.runId === state.runId)) states.push(state)
    }

    return states
  }

  private async readStateByRunId(
    runId: string,
  ): Promise<MagiRunState | undefined> {
    const active = this.active.get(runId)
    if (active) return active

    const knownPath = this.runPaths.get(runId)
    if (knownPath) {
      const state = await readFile(knownPath, "utf8")
        .then((text) => JSON.parse(text) as MagiRunState)
        .catch(() => undefined)
      if (state) return state
    }

    return (await this.listStates()).find((state) => state.runId === runId)
  }

  private async persist(state: MagiRunState): Promise<void> {
    state.updatedAt = now()
    await mkdir(state.outputDir, { recursive: true })
    const path = join(state.outputDir, "state.json")
    this.runPaths.set(state.runId, path)
    await writeFile(path, `${JSON.stringify(state, null, 2)}\n`)
  }

  private async notify(
    state: MagiRunState,
    text: string,
    options: { reply?: boolean } = {},
  ): Promise<void> {
    if (!state.parentSessionId || !this.input.client.session.promptAsync) return
    void options

    await this.input.client.session
      .promptAsync({
        body: {
          parts: [{ type: "text", text, synthetic: true }],
        },
        path: { id: state.parentSessionId },
      })
      .catch(() => undefined)
  }
}
