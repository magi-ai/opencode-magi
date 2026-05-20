import type {
  DuplicateIssueCandidate,
  IssueComment,
  IssueMeta,
  RelatedPullRequest,
} from "../github/commands"
import type {
  EditOutput,
  Exec,
  MagiConfig,
  ResolvedRepository,
  ResolvedTriageAgent,
  TriageAction,
  TriageActionOutput,
  TriageAskReason,
  TriageBinaryVote,
  TriageCategoryVote,
  TriageCommentClassification,
  TriageDecision,
  TriageDuplicateOutput,
  TriageDuplicateVote,
  TriageExistingPrVote,
  TriageVoteOutput,
} from "../types"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { issueRunOutputDir } from "../config/output"
import { worktreeBaseDir } from "../config/worktree"
import {
  assignIssue,
  closeIssue,
  closePullRequest,
  configureGitIdentity,
  createPullRequest,
  fetchIssue,
  fetchIssueComments,
  fetchRelatedPullRequests,
  postIssueComment,
  pushHead,
  removeIssueLabels,
  removeWorktree,
  searchDuplicateIssues,
  shellQuote,
  updateIssueComment,
} from "../github/commands"
import {
  composeTriageAcceptancePrompt,
  composeTriageActionPrompt,
  composeTriageCategoryPrompt,
  composeTriageCommentClassificationPrompt,
  composeTriageCommentPrompt,
  composeTriageCreatePrPrompt,
  composeTriageDuplicatePrompt,
  composeTriageExistingPrPrompt,
  composeTriageQuestionPrompt,
  composeTriageReconsiderPrompt,
} from "../prompts/compose"
import {
  parseTriageActionOutput,
  parseTriageBinaryOutput,
  parseTriageCategoryOutput,
  parseTriageCommentClassificationOutput,
  parseTriageCreatePrOutput,
  parseTriageDuplicateOutput,
  parseTriageExistingPrOutput,
} from "../prompts/output"
import { aggregateStringMajority, majorityThreshold } from "./majority"
import {
  runModelText,
  runModelWithRepair,
  type ModelClient,
  type ModelRunResult,
  type ModelRunProgress,
} from "./model"

type FinalResult = TriageDecision

export interface TriageRunInput {
  client: ModelClient
  config: MagiConfig
  directory: string
  dryRun?: boolean
  exec: Exec
  issue: number
  onProgress?: (progress: TriageRunProgress) => void | Promise<void>
  repository: ResolvedRepository
  runId?: string
  signal?: AbortSignal
}

export interface TriageRunResult {
  issue: number
  outputDir: string
  report: string
  result: FinalResult
}

export type TriageRunProgress =
  | { phase: string; type: "phase" }
  | { action: TriageAction; result: FinalResult; type: "decision" }
  | { phase: string; reviewer: string; type: "triage_agent_started" }
  | {
      options?: ModelRunProgress["options"]
      phase: string
      reviewer: string
      sessionId: string
      type: "triage_agent_session"
    }
  | {
      phase: string
      reviewer: string
      sessionId: string
      type: "triage_agent_response"
    }
  | { phase: string; reviewer: string; type: "triage_agent_repair" }
  | {
      phase: string
      reviewer: string
      sessionId: string
      type: "triage_agent_completed"
      vote: string
    }
  | {
      error: string
      phase: string
      reviewer: string
      type: "triage_agent_failed"
    }
  | { type: "comment_posting" }
  | { type: "comment_posted"; url: string }
  | { type: "pr_creation_started" }
  | { type: "triage_creator_started" }
  | {
      options?: ModelRunProgress["options"]
      sessionId: string
      type: "triage_creator_session"
    }
  | { sessionId: string; type: "triage_creator_response" }
  | { type: "triage_creator_repair" }
  | { sessionId: string; type: "triage_creator_completed" }
  | { error: string; type: "triage_creator_failed" }
  | { type: "pr_created"; url: string }
  | { branch: string; type: "worktree_created"; worktreePath: string }

interface TriageMarker {
  action?: string
  checkpoint?: number
  commentId?: number
  issue?: number
  pr?: string
  processed: number[]
  result?: string
  category?: string | null
  disposition?: TriageDecision["disposition"]
  askReason?: TriageAskReason
  v: number
}

interface RelationshipSummary {
  comments: IssueComment[]
  duplicateCandidates: DuplicateIssueCandidate[]
  mentionReplies: IssueComment[]
  previousMarker?: TriageMarker
  relatedPullRequests: RelatedPullRequest[]
}

interface ActionPlan {
  action: TriageAction
  allowedActions: TriageAction[]
  clearLabels: boolean
  closeIssue: boolean
  createPr: boolean
  postComment: boolean
}

type TriagePromptComposer = (input: {
  context: string
  directory: string
  issue: number
  repository: ResolvedRepository
  reviewer: ResolvedTriageAgent
}) => Promise<string>

const MARKER_PREFIX = "opencode-magi:triage"
const BINARY_VOTES = ["ASK", "NO", "YES"] as const
const DUPLICATE_VOTES = ["DUPLICATE", "NOT_DUPLICATE"] as const
const EXISTING_PR_VOTES = [
  "RELATED_PR_DOES_NOT_HANDLE_ISSUE",
  "RELATED_PR_HANDLES_ISSUE",
] as const
const RECONSIDERATION_CLASSES = new Set<TriageCommentClassification>([
  "CLARIFICATION",
  "NEW_EVIDENCE",
  "OBJECTION",
])

function marker(input: {
  action: string
  checkpoint?: number | "pending"
  decision: TriageDecision
  issue: number
  pr?: number
  processed?: number[]
}): string {
  const askReason = input.decision.askReason
    ? ` askReason=${input.decision.askReason}`
    : ""

  return `<!-- ${MARKER_PREFIX} v=2 issue=${input.issue} category=${input.decision.category ?? "none"} disposition=${input.decision.disposition}${askReason} action=${input.action} checkpoint=${input.checkpoint ?? "pending"} pr=${input.pr ?? "none"} processed=${(input.processed ?? []).join(",")} -->`
}

export function parseTriageMarker(body: string): TriageMarker | undefined {
  const match = body.match(/<!--\s*opencode-magi:triage\s+([^>]+?)\s*-->/)
  if (!match) return undefined

  const entries = Object.fromEntries(
    match[1]
      .trim()
      .split(/\s+/)
      .map((part) => {
        const index = part.indexOf("=")
        return index === -1
          ? [part, ""]
          : [part.slice(0, index), part.slice(index + 1)]
      }),
  )
  const version = Number(entries.v)

  if (version !== 1 && version !== 2) return undefined

  return {
    action: entries.action,
    askReason:
      entries.askReason === "acceptance_unclear" ||
      entries.askReason === "category_unclear"
        ? entries.askReason
        : undefined,
    category:
      entries.category === "none" ? null : entries.category || undefined,
    checkpoint:
      entries.checkpoint && Number.isFinite(Number(entries.checkpoint))
        ? Number(entries.checkpoint)
        : undefined,
    disposition:
      entries.disposition === "accepted" ||
      entries.disposition === "rejected" ||
      entries.disposition === "ask" ||
      entries.disposition === "duplicate" ||
      entries.disposition === "clear_only" ||
      entries.disposition === "failed"
        ? entries.disposition
        : undefined,
    issue: entries.issue ? Number(entries.issue) : undefined,
    pr: entries.pr,
    processed: entries.processed
      ? entries.processed.split(",").filter(Boolean).map(Number)
      : [],
    result: entries.result,
    v: version,
  }
}

function labelsContain(labels: string[], targets: string[]): boolean {
  const set = new Set(labels.map((label) => label.toLowerCase()))

  return targets.some((target) => set.has(target.toLowerCase()))
}

function existingClearLabels(issue: IssueMeta, labels: string[]): string[] {
  const existing = new Set(issue.labels.map((label) => label.toLowerCase()))

  return labels.filter((label) => existing.has(label.toLowerCase()))
}

export function resolveIssueCategory(
  issue: IssueMeta,
  repository: ResolvedRepository,
): string | undefined {
  const triage = repository.triage
  if (!triage) throw new Error("triage configuration is required")

  const matches = triage.categories.filter(
    (category) =>
      labelsContain(issue.labels, category.labels) ||
      (issue.type != null && category.types.includes(issue.type)),
  )

  if (matches.length !== 1) return undefined

  return matches[0].id
}

function issueContext(input: {
  issue: IssueMeta
  relationship: RelationshipSummary
  reconsideration?: {
    classifications?: unknown
    previousMarker: TriageMarker
    triggeringComments: IssueComment[]
  }
}): string {
  return JSON.stringify(
    {
      duplicateCandidates: input.relationship.duplicateCandidates,
      issue: input.issue,
      recentComments: input.relationship.comments.slice(-20),
      reconsideration: input.reconsideration,
      relatedPullRequests: input.relationship.relatedPullRequests,
    },
    null,
    2,
  )
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

async function emitProgress(
  input: TriageRunInput,
  progress: TriageRunProgress,
): Promise<void> {
  await input.onProgress?.(progress)
}

async function emitTriageModelProgress(input: {
  progress: ModelRunProgress
  phase: string
  run: TriageRunInput
  reviewer: string
}): Promise<void> {
  if (input.progress.type === "session_created") {
    await emitProgress(input.run, {
      options: input.progress.options,
      phase: input.phase,
      reviewer: input.reviewer,
      sessionId: input.progress.sessionId,
      type: "triage_agent_session",
    })
  }
  if (input.progress.type === "repair") {
    await emitProgress(input.run, {
      phase: input.phase,
      reviewer: input.reviewer,
      type: "triage_agent_repair",
    })
  }
  if (input.progress.type === "response") {
    await emitProgress(input.run, {
      phase: input.phase,
      reviewer: input.reviewer,
      sessionId: input.progress.sessionId,
      type: "triage_agent_response",
    })
  }
}

async function runVote<
  T extends string,
  O extends TriageVoteOutput<T> = TriageVoteOutput<T>,
>(input: {
  agent: ResolvedTriageAgent
  client: ModelClient
  context: string
  directory: string
  issue: number
  parse: (text: string) => O
  phase: string
  prompt: TriagePromptComposer
  repository: ResolvedRepository
  run: TriageRunInput
  schemaName: string
  signal?: AbortSignal
}): Promise<O & { promptText: string; raw: string; sessionId: string }> {
  const prompt = await input.prompt({
    context: input.context,
    directory: input.directory,
    issue: input.issue,
    repository: input.repository,
    reviewer: input.agent,
  })
  await emitProgress(input.run, {
    phase: input.phase,
    reviewer: input.agent.key,
    type: "triage_agent_started",
  })
  let result: ModelRunResult<O>
  try {
    result = await runModelWithRepair({
      client: input.client,
      model: input.agent.model,
      onProgress: (progress) =>
        emitTriageModelProgress({
          phase: input.phase,
          progress,
          reviewer: input.agent.key,
          run: input.run,
        }),
      options: input.agent.options,
      parse: input.parse,
      permission: input.agent.permission,
      prompt,
      repairAttempts: 3,
      schemaName: input.schemaName,
      signal: input.signal,
      title: `Magi triage ${input.schemaName} #${input.issue} (${input.agent.key})`,
    })
  } catch (error) {
    await emitProgress(input.run, {
      error: error instanceof Error ? error.message : String(error),
      phase: input.phase,
      reviewer: input.agent.key,
      type: "triage_agent_failed",
    })
    throw error
  }

  await emitProgress(input.run, {
    phase: input.phase,
    reviewer: input.agent.key,
    sessionId: result.sessionId,
    type: "triage_agent_completed",
    vote: result.value.vote,
  })

  return {
    ...result.value,
    promptText: prompt,
    raw: result.raw,
    sessionId: result.sessionId,
  }
}

async function writeVoteArtifacts(input: {
  output: TriageVoteOutput & { promptText: string; raw: string }
  outputDir: string
  phase: string
  reviewer: string
}): Promise<void> {
  const base = join(input.outputDir, `${input.reviewer}.${input.phase}`)

  await writeFile(`${base}.prompt.txt`, `${input.output.promptText}\n`)
  await writeFile(`${base}.raw.txt`, `${input.output.raw}\n`)
  await writeJson(`${base}.json`, {
    reason: input.output.reason,
    vote: input.output.vote,
  })
}

export function chooseDuplicateOutput(input: {
  candidateNumbers: number[]
  outputs: TriageDuplicateOutput[]
}): TriageDuplicateOutput | undefined {
  const candidates = new Set(input.candidateNumbers)
  const threshold = majorityThreshold(input.outputs.length)
  const counts = new Map<number, number>()

  for (const output of input.outputs) {
    if (
      output.vote !== "DUPLICATE" ||
      output.duplicateOf == null ||
      !candidates.has(output.duplicateOf)
    ) {
      continue
    }
    counts.set(output.duplicateOf, (counts.get(output.duplicateOf) ?? 0) + 1)
  }

  const target = [...counts.entries()].find(
    ([, count]) => count >= threshold,
  )?.[0]
  if (target == null) return undefined

  return input.outputs.find(
    (output) => output.vote === "DUPLICATE" && output.duplicateOf === target,
  )
}

async function runDuplicateVote(input: {
  candidateNumbers: number[]
  context: string
  input: TriageRunInput
  outputDir: string
}): Promise<TriageDuplicateOutput | undefined> {
  const agents = input.input.repository.agents.triage
  if (!agents?.length) throw new Error("triage.agents is required")
  await emitProgress(input.input, { phase: "duplicate", type: "phase" })

  const outputs = await Promise.all(
    agents.map((agent) =>
      runVote<TriageDuplicateVote, TriageDuplicateOutput>({
        agent,
        client: input.input.client,
        context: input.context,
        directory: input.input.directory,
        issue: input.input.issue,
        parse: parseTriageDuplicateOutput,
        phase: "duplicate",
        prompt: composeTriageDuplicatePrompt,
        repository: input.input.repository,
        run: input.input,
        schemaName: "triage duplicate",
        signal: input.input.signal,
      }),
    ),
  )
  const majority = aggregateStringMajority(
    outputs.map((output, index) => ({
      reviewer: agents[index].key,
      vote: output.vote,
    })),
    DUPLICATE_VOTES,
  )

  await Promise.all(
    outputs.map((output, index) =>
      writeVoteArtifacts({
        output,
        outputDir: input.outputDir,
        phase: "duplicate",
        reviewer: agents[index].key,
      }),
    ),
  )
  await Promise.all(
    outputs.map((output, index) =>
      writeJson(join(input.outputDir, `${agents[index].key}.duplicate.json`), {
        duplicateOf: output.duplicateOf,
        reason: output.reason,
        vote: output.vote,
      }),
    ),
  )

  await writeJson(join(input.outputDir, "duplicate-majority.json"), majority)

  if (majority.vote !== "DUPLICATE") return undefined

  return chooseDuplicateOutput({
    candidateNumbers: input.candidateNumbers,
    outputs,
  })
}

async function runPhaseVote<T extends string>(input: {
  context: string
  input: TriageRunInput
  outputDir: string
  parse: (text: string) => TriageVoteOutput<T>
  phase: string
  prompt: TriagePromptComposer
  schemaName: string
  votes: readonly T[]
}): Promise<T | undefined> {
  const agents = input.input.repository.agents.triage
  if (!agents?.length) throw new Error("triage.agents is required")
  await emitProgress(input.input, { phase: input.phase, type: "phase" })

  const outputs = await Promise.all(
    agents.map((agent) =>
      runVote<T>({
        agent,
        client: input.input.client,
        context: input.context,
        directory: input.input.directory,
        issue: input.input.issue,
        parse: input.parse,
        phase: input.phase,
        prompt: input.prompt,
        repository: input.input.repository,
        run: input.input,
        schemaName: input.schemaName,
        signal: input.input.signal,
      }),
    ),
  )
  const majority = aggregateStringMajority(
    outputs.map((output, index) => ({
      reviewer: agents[index].key,
      vote: output.vote,
    })),
    input.votes,
  )

  await Promise.all(
    outputs.map((output, index) =>
      writeVoteArtifacts({
        output,
        outputDir: input.outputDir,
        phase: input.phase,
        reviewer: agents[index].key,
      }),
    ),
  )

  await writeJson(
    join(input.outputDir, `${input.phase}-majority.json`),
    majority,
  )

  return majority.vote
}

async function relationshipScan(input: TriageRunInput, issue: IssueMeta) {
  const [comments, relatedPullRequests, duplicateCandidates] =
    await Promise.all([
      fetchIssueComments(input.exec, input.repository, input.issue),
      fetchRelatedPullRequests(input.exec, input.repository, input.issue),
      searchDuplicateIssues(input.exec, input.repository, issue),
    ])
  const markers = comments
    .filter((comment) => comment.author === input.repository.triage?.account)
    .map((comment) => {
      const parsed = parseTriageMarker(comment.body)
      return parsed ? { ...parsed, commentId: comment.id } : undefined
    })
    .filter(Boolean) as TriageMarker[]
  const previousMarker = markers.at(-1)
  const mentionReplies = previousMarker
    ? eligibleMentionReplies({
        account: input.repository.triage?.account ?? "",
        comments,
        marker: previousMarker,
        processed: previousMarker.processed,
        repository: input.repository,
      })
    : []

  return {
    comments,
    duplicateCandidates,
    mentionReplies,
    previousMarker,
    relatedPullRequests,
  }
}

function mentionsAccount(body: string, account: string): boolean {
  return new RegExp(
    `@${account.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
    "i",
  ).test(body)
}

function markerCheckpoint(marker: TriageMarker): number | undefined {
  return marker.checkpoint ?? marker.commentId
}

function markerPr(marker: TriageMarker): number | undefined {
  const pr = Number(marker.pr)

  return Number.isInteger(pr) && pr > 0 ? pr : undefined
}

function pullRequestNumberFromUrl(url: string): number | undefined {
  const match = url.match(/\/pull\/(\d+)(?:\D|$)/)
  const number = match ? Number(match[1]) : undefined

  return number && Number.isInteger(number) ? number : undefined
}

export function mentionAllowed(
  comment: IssueComment,
  repository: ResolvedRepository,
): boolean {
  const safety = repository.triage?.safety
  if (!safety) return false

  const actorAllowed = safety.allowMentionActors.length
    ? safety.allowMentionActors.includes(comment.author)
    : false
  const roleAllowed = safety.allowMentionRoles.length
    ? safety.allowMentionRoles.includes(comment.authorAssociation ?? "")
    : false

  return safety.allowMentionActors.length || safety.allowMentionRoles.length
    ? actorAllowed || roleAllowed
    : true
}

export function eligibleMentionReplies(input: {
  account: string
  comments: IssueComment[]
  marker: TriageMarker
  processed: number[]
  repository: ResolvedRepository
}): IssueComment[] {
  const checkpoint = markerCheckpoint(input.marker)
  const processed = new Set(input.processed)

  return input.comments.filter((comment) => {
    if (checkpoint != null && comment.id <= checkpoint) return false
    if (processed.has(comment.id)) return false
    if (!mentionsAccount(comment.body, input.account)) return false

    return mentionAllowed(comment, input.repository)
  })
}

function finalResultFromMarker(marker: TriageMarker): FinalResult {
  if (marker.disposition) {
    return {
      askReason: marker.askReason,
      category: marker.category ?? null,
      disposition: marker.disposition,
    }
  }

  switch (marker.result) {
    case "BUG_ACCEPTED":
    case "RESOLVED_BY_MERGED_PR":
      return { category: "bug", disposition: "accepted" }
    case "BUG_REJECTED":
      return { category: "bug", disposition: "rejected" }
    case "FEATURE_ACCEPTED":
      return { category: "feature", disposition: "accepted" }
    case "FEATURE_REJECTED":
      return { category: "feature", disposition: "rejected" }
    case "ASK":
      return {
        askReason: "acceptance_unclear",
        category: null,
        disposition: "ask",
      }
    case "CLEAR_ONLY":
      return { category: null, disposition: "clear_only" }
    case "DUPLICATE":
      return { category: null, disposition: "duplicate" }
    default:
      return { category: null, disposition: "failed" }
  }
}

function decisionText(decision: TriageDecision): string {
  return JSON.stringify(decision)
}

function actionPlan(input: {
  result: FinalResult
  triage: NonNullable<ResolvedRepository["triage"]>
}): ActionPlan {
  if (input.result.disposition === "clear_only") {
    return {
      action: "CLEAR_ONLY",
      allowedActions: ["CLEAR_ONLY"],
      clearLabels: true,
      closeIssue: false,
      createPr: false,
      postComment: false,
    }
  }
  if (input.result.disposition === "ask") {
    return {
      action: "ASK",
      allowedActions: ["ASK"],
      clearLabels: false,
      closeIssue: false,
      createPr: false,
      postComment: true,
    }
  }

  const closeIssue =
    input.triage.automation.close &&
    (input.result.disposition === "rejected" ||
      input.result.disposition === "duplicate")
  const createPr =
    input.triage.automation.pr && input.result.disposition === "accepted"

  return {
    action: closeIssue ? "CLOSE" : createPr ? "PR" : "COMMENT",
    allowedActions: [closeIssue ? "CLOSE" : createPr ? "PR" : "COMMENT"],
    clearLabels: true,
    closeIssue,
    createPr,
    postComment: true,
  }
}

function previousAutomationPlan(input: {
  issue: IssueMeta
  marker: TriageMarker
  relationship: RelationshipSummary
  result: FinalResult
  triage: NonNullable<ResolvedRepository["triage"]>
}): ActionPlan | undefined {
  const base = actionPlan({ result: input.result, triage: input.triage })
  const clearLabels =
    base.clearLabels &&
    existingClearLabels(input.issue, input.triage.automation.clear).length > 0
  const closeIssue =
    input.marker.action === "CLOSE" &&
    base.closeIssue &&
    input.issue.state === "OPEN"
  const createPr =
    input.marker.action === "PR" &&
    base.createPr &&
    !markerPr(input.marker) &&
    !input.relationship.relatedPullRequests.length

  if (!clearLabels && !closeIssue && !createPr) return undefined

  const action = closeIssue ? "CLOSE" : createPr ? "PR" : "CLEAR_ONLY"

  return {
    ...base,
    action,
    allowedActions: [action],
    clearLabels,
    closeIssue,
    createPr,
    postComment: false,
  }
}

async function runActionPrompt(input: {
  context: string
  input: TriageRunInput
  outputDir: string
  plan: ActionPlan
  result: FinalResult
}): Promise<TriageActionOutput> {
  const agent = input.input.repository.agents.triage?.[0]
  if (!agent) throw new Error("triage.agents is required")
  const context = JSON.stringify(
    {
      allowedActions: input.plan.allowedActions,
      deterministicPlan: input.plan,
      result: input.result,
      triageContext: input.context,
    },
    null,
    2,
  )
  const prompt = await composeTriageActionPrompt({
    context,
    directory: input.input.directory,
    issue: input.input.issue,
    repository: input.input.repository,
    reviewer: agent,
  })
  const result = await runModelWithRepair<TriageActionOutput>({
    client: input.input.client,
    model: agent.model,
    options: agent.options,
    parse: parseTriageActionOutput,
    permission: agent.permission,
    prompt,
    repairAttempts: 3,
    schemaName: "triage action",
    signal: input.input.signal,
    title: `Magi triage action #${input.input.issue}`,
  })

  await writeJson(join(input.outputDir, "action.json"), {
    model: result.value,
    plan: input.plan,
  })

  return result.value
}

async function classifyMentionReplies(input: {
  context: string
  input: TriageRunInput
  outputDir: string
  replies: IssueComment[]
}) {
  const agent = input.input.repository.agents.triage?.[0]
  if (!agent) throw new Error("triage.agents is required")
  const prompt = await composeTriageCommentClassificationPrompt({
    context: JSON.stringify(
      { context: input.context, mentionReplies: input.replies },
      null,
      2,
    ),
    directory: input.input.directory,
    issue: input.input.issue,
    repository: input.input.repository,
    reviewer: agent,
  })
  const result = await runModelWithRepair({
    client: input.input.client,
    model: agent.model,
    options: agent.options,
    parse: parseTriageCommentClassificationOutput,
    permission: agent.permission,
    prompt,
    repairAttempts: 3,
    schemaName: "triage comment classification",
    signal: input.input.signal,
    title: `Magi triage comment classification #${input.input.issue}`,
  })

  await writeJson(
    join(input.outputDir, "comment-classification.json"),
    result.value,
  )

  return result.value
}

async function runReconsiderationVote(input: {
  context: string
  input: TriageRunInput
  outputDir: string
}): Promise<TriageBinaryVote | undefined> {
  return runPhaseVote<TriageBinaryVote>({
    context: input.context,
    input: input.input,
    outputDir: input.outputDir,
    parse: parseTriageBinaryOutput,
    phase: "reconsider",
    prompt: composeTriageReconsiderPrompt,
    schemaName: "triage reconsider",
    votes: BINARY_VOTES,
  })
}

async function composeResultComment(input: {
  action: string
  context: string
  input: TriageRunInput
  issue: IssueMeta
  outputDir: string
  processed?: number[]
  result: FinalResult
}): Promise<string> {
  const agents = input.input.repository.agents.triage
  if (!agents?.length) throw new Error("triage.agents is required")
  if (
    input.result.disposition === "ask" &&
    input.result.askReason === "category_unclear"
  ) {
    const language = input.input.repository.language?.toLowerCase() ?? ""
    const body =
      language.includes("ja") || language.includes("japanese")
        ? `@${input.issue.author} 現在の説明だけでは、何をすべきか判断できません。\n\n期待する動作、実際の動作、必要な理由、関連する例・ログ・スクリーンショットなどを追記してください。`
        : `@${input.issue.author} I can't determine what should be done from the current description.\n\nPlease add more detail, such as the expected behavior, the actual behavior, the reason this is needed, or any relevant examples, logs, or screenshots.`
    const comment = `${body}\n\n${marker({
      action: input.action,
      checkpoint: "pending",
      decision: input.result,
      issue: input.issue.number,
      processed: input.processed,
    })}`

    await writeFile(join(input.outputDir, "comment.md"), `${comment}\n`)
    return comment
  }
  const prompt = await (
    input.result.disposition === "ask"
      ? composeTriageQuestionPrompt
      : composeTriageCommentPrompt
  )({
    author: input.issue.author,
    context: input.context,
    directory: input.input.directory,
    issue: input.issue.number,
    repository: input.input.repository,
  })
  const comment =
    (
      await runModelText({
        allowEmpty: false,
        client: input.input.client,
        model: agents[0].model,
        options: agents[0].options,
        permission: agents[0].permission,
        prompt,
        signal: input.input.signal,
        title: `Magi triage comment #${input.issue.number}`,
      })
    ).raw +
    `\n\n${marker({
      action: input.action,
      checkpoint: "pending",
      decision: input.result,
      issue: input.issue.number,
      processed: input.processed,
    })}`

  await writeFile(join(input.outputDir, "comment.md"), `${comment}\n`)

  return comment
}

async function postMarkedIssueComment(input: {
  account: string
  body: string
  exec: Exec
  issue: number
  outputDir: string
  repository: ResolvedRepository
}): Promise<{ id: number; url: string }> {
  const posted = await postIssueComment(
    input.exec,
    input.repository,
    input.issue,
    input.account,
    input.body,
  )
  const body = input.body.replace(
    "checkpoint=pending",
    `checkpoint=${posted.id}`,
  )
  const updated =
    body === input.body
      ? posted
      : await updateIssueComment(
          input.exec,
          input.repository,
          posted.id,
          input.account,
          body,
        )

  await writeJson(join(input.outputDir, "posted.json"), updated)

  return updated
}

async function persistProcessedMarker(input: {
  account: string
  comments: IssueComment[]
  exec: Exec
  issue: IssueMeta
  marker: TriageMarker
  outputDir: string
  processed: number[]
  pr?: number
  repository: ResolvedRepository
}): Promise<void> {
  if (!input.marker.commentId) return
  const previousComment = input.comments.find(
    (comment) => comment.id === input.marker.commentId,
  )
  if (!previousComment) return
  const updatedMarker = marker({
    action: input.marker.action ?? input.marker.result ?? "ASK",
    checkpoint: markerCheckpoint(input.marker),
    decision: finalResultFromMarker(input.marker),
    issue: input.issue.number,
    pr: input.pr ?? markerPr(input.marker),
    processed: input.processed,
  })
  const body = previousComment.body.replace(
    /<!--\s*opencode-magi:triage\s+[^>]+?\s*-->/,
    updatedMarker,
  )

  if (body === previousComment.body) return

  const updated = await updateIssueComment(
    input.exec,
    input.repository,
    input.marker.commentId,
    input.account,
    body,
  )
  await writeJson(join(input.outputDir, "processed.json"), {
    processed: input.processed,
    updated,
  })
}

async function finishWithResult(input: {
  context: string
  input: TriageRunInput
  issue: IssueMeta
  outputDir: string
  plan?: ActionPlan
  processed?: number[]
  previousMarker?: TriageMarker
  relationship: RelationshipSummary
  result: FinalResult
}): Promise<TriageRunResult> {
  const triage = input.input.repository.triage
  if (!triage) throw new Error("triage configuration is required")
  const plan = input.plan ?? actionPlan({ result: input.result, triage })
  await emitProgress(input.input, {
    action: plan.action,
    result: input.result,
    type: "decision",
  })
  await runActionPrompt({
    context: input.context,
    input: input.input,
    outputDir: input.outputDir,
    plan,
    result: input.result,
  })

  let prUrl: string | undefined
  const comment = plan.postComment
    ? await composeResultComment({
        action: plan.action,
        context: `Result: ${decisionText(input.result)}\nAction: ${plan.action}\n\n${input.context}`,
        input: input.input,
        issue: input.issue,
        outputDir: input.outputDir,
        processed: input.processed,
        result: input.result,
      })
    : undefined

  if (!input.input.dryRun) {
    if (comment) {
      await emitProgress(input.input, { type: "comment_posting" })
      const posted = await postMarkedIssueComment({
        account: triage.account ?? "",
        body: comment,
        exec: input.input.exec,
        issue: input.issue.number,
        outputDir: input.outputDir,
        repository: input.input.repository,
      })
      await emitProgress(input.input, {
        type: "comment_posted",
        url: posted.url,
      })
    }
    if (plan.clearLabels) {
      const clearLabels = existingClearLabels(
        input.issue,
        triage.automation.clear,
      )

      if (clearLabels.length) {
        await removeIssueLabels(
          input.input.exec,
          input.input.repository,
          input.issue.number,
          clearLabels,
          triage.account ?? "",
        )
      }
    }
    if (plan.closeIssue) {
      const closedPrs: number[] = []
      for (const pr of input.relationship.relatedPullRequests.filter(
        (pr) => pr.state === "OPEN",
      )) {
        await closePullRequest(
          input.input.exec,
          input.input.repository,
          pr.number,
          triage.account ?? "",
        )
        closedPrs.push(pr.number)
      }
      if (closedPrs.length)
        await writeJson(join(input.outputDir, "closed-prs.json"), closedPrs)
      await closeIssue(
        input.input.exec,
        input.input.repository,
        input.issue.number,
        triage.account ?? "",
      )
    }
    if (plan.createPr) {
      prUrl = await createImplementationPr({
        context: input.context,
        input: input.input,
        issue: input.issue,
        outputDir: input.outputDir,
      })
      if (prUrl) {
        await writeJson(join(input.outputDir, "pr.json"), { url: prUrl })
        await emitProgress(input.input, { type: "pr_created", url: prUrl })
      }
    }
    if (input.previousMarker && prUrl) {
      await persistProcessedMarker({
        account: triage.account ?? "",
        comments: input.relationship.comments,
        exec: input.input.exec,
        issue: input.issue,
        marker: input.previousMarker,
        outputDir: input.outputDir,
        pr: pullRequestNumberFromUrl(prUrl),
        processed: input.processed ?? input.previousMarker.processed,
        repository: input.input.repository,
      })
    }
  }

  const report = [
    `Magi triage result for #${input.issue.number}: ${decisionText(input.result)}`,
    prUrl ? `Created PR: ${prUrl}` : undefined,
    input.input.dryRun
      ? "Dry run: no GitHub mutations were performed."
      : undefined,
  ]
    .filter(Boolean)
    .join("\n")
  await writeFile(join(input.outputDir, "report.md"), `${report}\n`)

  return {
    issue: input.issue.number,
    outputDir: input.outputDir,
    report,
    result: input.result,
  }
}

function safetyBlocked(
  input: TriageRunInput,
  issue: IssueMeta,
  hasMarker: boolean,
): string | undefined {
  const triage = input.repository.triage
  if (!triage) throw new Error("triage configuration is required")
  const safety = triage.safety

  if (issue.state === "CLOSED") return "issue is closed"
  if (!hasMarker && safety.requiredLabels.length) {
    const missing = safety.requiredLabels.filter(
      (label) => !labelsContain(issue.labels, [label]),
    )
    if (missing.length) return `missing required labels: ${missing.join(", ")}`
  }
  if (
    safety.blockedLabels.some((label) => labelsContain(issue.labels, [label]))
  ) {
    return "issue has a blocked label"
  }
  if (
    safety.allowAuthors.length &&
    !safety.allowAuthors.includes(issue.author)
  ) {
    return `issue author is not allowed: ${issue.author}`
  }

  return undefined
}

async function createImplementationPr(input: {
  context: string
  input: TriageRunInput
  issue: IssueMeta
  outputDir: string
}): Promise<string | undefined> {
  const creator = input.input.repository.agents.triageCreator
  if (!creator) return undefined
  const triage = input.input.repository.triage
  if (!triage?.account) throw new Error("triage.account is required")
  await emitProgress(input.input, { type: "pr_creation_started" })
  await emitProgress(input.input, { type: "triage_creator_started" })

  try {
    await assignIssue(
      input.input.exec,
      input.input.repository,
      input.issue.number,
      triage.account,
    )

    const branch = `magi/issue-${input.issue.number}-${Date.now().toString(36)}`
    const worktreePath = join(
      worktreeBaseDir(input.input.directory, input.input.config, "issue"),
      `issue-${input.issue.number}`,
    )
    await mkdir(dirname(worktreePath), { recursive: true })
    await input.input.exec(
      `git worktree add -b ${shellQuote(branch)} ${shellQuote(worktreePath)}`,
    )
    await emitProgress(input.input, {
      branch,
      type: "worktree_created",
      worktreePath,
    })
    try {
      await configureGitIdentity(input.input.exec, worktreePath, creator.author)
      const prompt = await composeTriageCreatePrPrompt({
        context: input.context,
        directory: input.input.directory,
        issue: input.issue.number,
        repository: input.input.repository,
        worktreePath,
      })
      const result = await runModelWithRepair<EditOutput>({
        client: input.input.client,
        model: creator.model,
        onProgress: async (progress) => {
          if (progress.type === "session_created") {
            await emitProgress(input.input, {
              options: progress.options,
              sessionId: progress.sessionId,
              type: "triage_creator_session",
            })
          }
          if (progress.type === "repair") {
            await emitProgress(input.input, { type: "triage_creator_repair" })
          }
          if (progress.type === "response") {
            await emitProgress(input.input, {
              sessionId: progress.sessionId,
              type: "triage_creator_response",
            })
          }
        },
        options: creator.options,
        parse: parseTriageCreatePrOutput,
        permission: creator.permission,
        prompt,
        repairAttempts: 3,
        schemaName: "triage create PR",
        signal: input.input.signal,
        title: `Magi triage create PR #${input.issue.number}`,
      })
      await emitProgress(input.input, {
        sessionId: result.sessionId,
        type: "triage_creator_completed",
      })

      await writeJson(join(input.outputDir, "create-pr.json"), result.value)
      if (result.value.mode !== "EDITED") return undefined
      const pullRequest = result.value.pullRequest
      if (!pullRequest) throw new Error("EDITED requires pullRequest")

      await pushHead(
        input.input.exec,
        input.input.repository,
        worktreePath,
        creator.account,
        {
          owner: input.input.repository.github.owner,
          ref: branch,
          repo: input.input.repository.github.repo,
        },
      )

      return createPullRequest(
        input.input.exec,
        input.input.repository,
        creator.account,
        {
          body: pullRequest.body,
          head: branch,
          title: pullRequest.title,
        },
      )
    } finally {
      await removeWorktree(input.input.exec, worktreePath).catch(
        () => undefined,
      )
    }
  } catch (error) {
    await emitProgress(input.input, {
      error: error instanceof Error ? error.message : String(error),
      type: "triage_creator_failed",
    })
    throw error
  }
}

export async function runTriage(
  input: TriageRunInput,
): Promise<TriageRunResult> {
  const triage = input.repository.triage
  if (!triage?.account) throw new Error("triage.account is required")
  const agents = input.repository.agents.triage
  if (!agents?.length) throw new Error("triage.agents is required")

  const runId = input.runId ?? `run-${Date.now().toString(36)}`
  const outputDir = issueRunOutputDir({
    config: input.config,
    directory: input.directory,
    issue: input.issue,
    runId,
  })
  await mkdir(outputDir, { recursive: true })

  await emitProgress(input, { phase: "fetching issue", type: "phase" })
  const issue = await fetchIssue(input.exec, input.repository, input.issue)
  await emitProgress(input, {
    phase: "scanning issue relationships",
    type: "phase",
  })
  const relationship = await relationshipScan(input, issue)
  const block = safetyBlocked(
    input,
    issue,
    Boolean(relationship.previousMarker),
  )

  await writeJson(join(outputDir, "issue.json"), issue)
  await writeJson(join(outputDir, "comments.json"), relationship.comments)
  await writeJson(join(outputDir, "relationship-summary.json"), relationship)
  if (relationship.previousMarker)
    await writeJson(
      join(outputDir, "previous-triage.json"),
      relationship.previousMarker,
    )

  if (block) {
    const report = `Magi triage blocked for #${input.issue}: ${block}`
    await writeFile(join(outputDir, "report.md"), `${report}\n`)
    return {
      issue: input.issue,
      outputDir,
      report,
      result: { category: null, disposition: "failed" },
    }
  }

  let context = issueContext({ issue, relationship })
  await writeFile(join(outputDir, "context.md"), `${context}\n`)
  await emitProgress(input, { phase: "triaging", type: "phase" })
  let processed = relationship.previousMarker?.processed ?? []
  let result: FinalResult | undefined

  if (relationship.previousMarker) {
    if (!relationship.mentionReplies.length) {
      const result = finalResultFromMarker(relationship.previousMarker)
      const plan = previousAutomationPlan({
        issue,
        marker: relationship.previousMarker,
        relationship,
        result,
        triage,
      })

      if (plan) {
        return finishWithResult({
          context,
          input,
          issue,
          outputDir,
          plan,
          previousMarker: relationship.previousMarker,
          processed,
          relationship,
          result,
        })
      }

      const report = `Magi triage skipped #${issue.number} because no eligible mention replies were found for reconsideration.`
      await writeFile(join(outputDir, "report.md"), `${report}\n`)
      return { issue: issue.number, outputDir, report, result }
    }

    const classifications = await classifyMentionReplies({
      context,
      input,
      outputDir,
      replies: relationship.mentionReplies,
    })
    const triggeringComments = relationship.mentionReplies.filter((comment) =>
      classifications.comments.some(
        (item) =>
          item.commentId === comment.id &&
          RECONSIDERATION_CLASSES.has(item.classification),
      ),
    )
    processed = [
      ...new Set([
        ...processed,
        ...classifications.comments.map((comment) => comment.commentId),
      ]),
    ]

    if (!triggeringComments.length) {
      if (!input.dryRun) {
        await persistProcessedMarker({
          account: triage.account,
          comments: relationship.comments,
          exec: input.exec,
          issue,
          marker: relationship.previousMarker,
          outputDir,
          processed,
          repository: input.repository,
        })
      }
      const result = finalResultFromMarker(relationship.previousMarker)
      const report = `Magi triage skipped #${issue.number} because allowed mention replies did not request reconsideration.`
      await writeFile(join(outputDir, "report.md"), `${report}\n`)
      return { issue: issue.number, outputDir, report, result }
    }

    context = issueContext({
      issue,
      relationship,
      reconsideration: {
        classifications,
        previousMarker: relationship.previousMarker,
        triggeringComments,
      },
    })
    await writeFile(join(outputDir, "context.md"), `${context}\n`)
    const vote = await runReconsiderationVote({ context, input, outputDir })
    const previous = finalResultFromMarker(relationship.previousMarker)
    result =
      vote === "YES"
        ? { category: previous.category, disposition: "accepted" }
        : vote === "NO"
          ? { category: previous.category, disposition: "rejected" }
          : {
              askReason: "acceptance_unclear",
              category: previous.category,
              disposition: "ask",
            }
  }

  if (!result && relationship.relatedPullRequests.length) {
    const vote = await runPhaseVote<TriageExistingPrVote>({
      context,
      input,
      outputDir,
      parse: parseTriageExistingPrOutput,
      phase: "existing-pr",
      prompt: composeTriageExistingPrPrompt,
      schemaName: "triage existing PR",
      votes: EXISTING_PR_VOTES,
    })
    if (vote === "RELATED_PR_HANDLES_ISSUE") {
      const merged = relationship.relatedPullRequests.some(
        (pr) => pr.state === "MERGED",
      )
      if (merged && triage.automation.close) {
        const relatedPrDecision: TriageDecision = {
          category: resolveIssueCategory(issue, input.repository) ?? null,
          disposition: "accepted",
        }
        const plan: ActionPlan = {
          action: "CLOSE",
          allowedActions: ["CLOSE"],
          clearLabels: true,
          closeIssue: true,
          createPr: false,
          postComment: true,
        }
        await emitProgress(input, {
          action: plan.action,
          result: relatedPrDecision,
          type: "decision",
        })
        await runActionPrompt({
          context,
          input,
          outputDir,
          plan,
          result: relatedPrDecision,
        })
        const body = await composeResultComment({
          action: "CLOSE",
          context: `Result: ${decisionText(relatedPrDecision)}\nAction: CLOSE\n\n${context}`,
          input,
          issue,
          outputDir,
          processed,
          result: relatedPrDecision,
        })
        if (!input.dryRun) {
          await emitProgress(input, { type: "comment_posting" })
          const posted = await postMarkedIssueComment({
            account: triage.account,
            body,
            exec: input.exec,
            issue: issue.number,
            outputDir,
            repository: input.repository,
          })
          await emitProgress(input, { type: "comment_posted", url: posted.url })
          const clearLabels = existingClearLabels(
            issue,
            triage.automation.clear,
          )

          if (clearLabels.length) {
            await removeIssueLabels(
              input.exec,
              input.repository,
              issue.number,
              clearLabels,
              triage.account,
            )
          }
          const closedPrs: number[] = []
          for (const pr of relationship.relatedPullRequests.filter(
            (pr) => pr.state === "OPEN",
          )) {
            await closePullRequest(
              input.exec,
              input.repository,
              pr.number,
              triage.account,
            )
            closedPrs.push(pr.number)
          }
          if (closedPrs.length)
            await writeJson(join(outputDir, "closed-prs.json"), closedPrs)
          await closeIssue(
            input.exec,
            input.repository,
            issue.number,
            triage.account,
          )
        }
        const report = `Magi triage closed #${issue.number} because a related PR was merged.`
        await writeFile(join(outputDir, "report.md"), `${report}\n`)
        return {
          issue: issue.number,
          outputDir,
          report,
          result: relatedPrDecision,
        }
      }
      return finishWithResult({
        context,
        input,
        issue,
        outputDir,
        processed,
        relationship,
        result: { category: null, disposition: "clear_only" },
      })
    }
  }

  if (!result && relationship.duplicateCandidates.length) {
    const duplicate = await runDuplicateVote({
      candidateNumbers: relationship.duplicateCandidates.map(
        (candidate) => candidate.number,
      ),
      context,
      input,
      outputDir,
    })
    if (duplicate) {
      context = `${context}\n\nDuplicate decision: ${JSON.stringify(duplicate)}`
      result = { category: null, disposition: "duplicate" }
    }
  }

  if (!result) {
    const resolvedCategory = resolveIssueCategory(issue, input.repository)
    await writeJson(join(outputDir, "category-resolution.json"), {
      category: resolvedCategory,
      source: resolvedCategory ? "config" : "vote",
    })
    const category =
      resolvedCategory ??
      (await runPhaseVote<TriageCategoryVote>({
        context,
        input,
        outputDir,
        parse: (text) =>
          parseTriageCategoryOutput(
            text,
            triage.categories.map((item) => item.id),
          ),
        phase: "category",
        prompt: composeTriageCategoryPrompt,
        schemaName: "triage category",
        votes: ["ASK", ...triage.categories.map((item) => item.id)],
      })) ??
      "ASK"

    if (category === "ASK") {
      result = {
        askReason: "category_unclear",
        category: null,
        disposition: "ask",
      }
    } else {
      const categoryConfig = triage.categories.find(
        (item) => item.id === category,
      )
      const voteContext = JSON.stringify(
        {
          category: categoryConfig,
          triageContext: context,
        },
        null,
        2,
      )
      const vote = await runPhaseVote<TriageBinaryVote>({
        context: voteContext,
        input,
        outputDir,
        parse: parseTriageBinaryOutput,
        phase: "acceptance",
        prompt: composeTriageAcceptancePrompt,
        schemaName: "triage acceptance",
        votes: BINARY_VOTES,
      })
      result =
        vote === "YES"
          ? { category, disposition: "accepted" }
          : vote === "NO"
            ? { category, disposition: "rejected" }
            : {
                askReason: "acceptance_unclear",
                category,
                disposition: "ask",
              }
    }
  }

  return finishWithResult({
    context,
    input,
    issue,
    outputDir,
    processed,
    relationship,
    result: result ?? {
      askReason: "acceptance_unclear",
      category: null,
      disposition: "ask",
    },
  })
}
