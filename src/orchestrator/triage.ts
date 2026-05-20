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
  TriageBinaryVote,
  TriageCommentClassification,
  TriageDuplicateOutput,
  TriageDuplicateVote,
  TriageExistingPrVote,
  TriageFinalVote,
  TriageKindVote,
  TriageVoteOutput,
} from "../types"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { issueRunOutputDir } from "../config/output"
import { worktreeBaseDir } from "../config/worktree"
import {
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
  composeTriageBugPrompt,
  composeTriageActionPrompt,
  composeTriageCommentClassificationPrompt,
  composeTriageCommentPrompt,
  composeTriageCreatePrPrompt,
  composeTriageDuplicatePrompt,
  composeTriageExistingPrPrompt,
  composeTriageFeaturePrompt,
  composeTriageKindPrompt,
  composeTriageQuestionPrompt,
  composeTriageReconsiderPrompt,
} from "../prompts/compose"
import {
  parseEditOutput,
  parseTriageActionOutput,
  parseTriageBinaryOutput,
  parseTriageCommentClassificationOutput,
  parseTriageDuplicateOutput,
  parseTriageExistingPrOutput,
  parseTriageFinalOutput,
  parseTriageKindOutput,
} from "../prompts/output"
import { aggregateStringMajority, majorityThreshold } from "./majority"
import { runModelText, runModelWithRepair, type ModelClient } from "./model"

type FinalResult =
  | "ASK"
  | "BUG_ACCEPTED"
  | "BUG_REJECTED"
  | "CLEAR_ONLY"
  | "DUPLICATE"
  | "FEATURE_ACCEPTED"
  | "FEATURE_REJECTED"
  | "FAILED"

export interface TriageRunInput {
  client: ModelClient
  config: MagiConfig
  directory: string
  dryRun?: boolean
  exec: Exec
  issue: number
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

interface TriageMarker {
  action?: string
  checkpoint?: number
  commentId?: number
  issue?: number
  pr?: string
  processed: number[]
  result?: string
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
const KIND_VOTES = ["ASK", "BUG", "FEATURE"] as const
const BINARY_VOTES = ["ASK", "NO", "YES"] as const
const DUPLICATE_VOTES = ["DUPLICATE", "NOT_DUPLICATE"] as const
const EXISTING_PR_VOTES = [
  "RELATED_PR_DOES_NOT_HANDLE_ISSUE",
  "RELATED_PR_HANDLES_ISSUE",
] as const
const FINAL_VOTES = [
  "ASK",
  "BUG_ACCEPTED",
  "BUG_REJECTED",
  "DUPLICATE",
  "FEATURE_ACCEPTED",
  "FEATURE_REJECTED",
] as const
const RECONSIDERATION_CLASSES = new Set<TriageCommentClassification>([
  "CLARIFICATION",
  "NEW_EVIDENCE",
  "OBJECTION",
])

function marker(input: {
  action: string
  checkpoint?: number | "pending"
  issue: number
  pr?: number
  processed?: number[]
  result: string
}): string {
  return `<!-- ${MARKER_PREFIX} v=1 issue=${input.issue} result=${input.result} action=${input.action} checkpoint=${input.checkpoint ?? "pending"} pr=${input.pr ?? "none"} processed=${(input.processed ?? []).join(",")} -->`
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

  if (version !== 1) return undefined

  return {
    action: entries.action,
    checkpoint:
      entries.checkpoint && Number.isFinite(Number(entries.checkpoint))
        ? Number(entries.checkpoint)
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

export function resolveIssueKind(
  issue: IssueMeta,
  repository: ResolvedRepository,
): "BUG" | "FEATURE" | undefined {
  const triage = repository.triage
  if (!triage) throw new Error("triage configuration is required")

  const bug =
    labelsContain(issue.labels, triage.kind.bug.label) ||
    (issue.type != null && triage.kind.bug.type.includes(issue.type))
  const feature =
    labelsContain(issue.labels, triage.kind.feature.label) ||
    (issue.type != null && triage.kind.feature.type.includes(issue.type))

  if (bug === feature) return undefined

  return bug ? "BUG" : "FEATURE"
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
  prompt: TriagePromptComposer
  repository: ResolvedRepository
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
  const result = await runModelWithRepair({
    client: input.client,
    model: input.agent.model,
    options: input.agent.options,
    parse: input.parse,
    permission: input.agent.permission,
    prompt,
    repairAttempts: 3,
    schemaName: input.schemaName,
    signal: input.signal,
    title: `Magi triage ${input.schemaName} #${input.issue} (${input.agent.key})`,
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

  const outputs = await Promise.all(
    agents.map((agent) =>
      runVote<TriageDuplicateVote, TriageDuplicateOutput>({
        agent,
        client: input.input.client,
        context: input.context,
        directory: input.input.directory,
        issue: input.input.issue,
        parse: parseTriageDuplicateOutput,
        prompt: composeTriageDuplicatePrompt,
        repository: input.input.repository,
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

  const outputs = await Promise.all(
    agents.map((agent) =>
      runVote<T>({
        agent,
        client: input.input.client,
        context: input.context,
        directory: input.input.directory,
        issue: input.input.issue,
        parse: input.parse,
        prompt: input.prompt,
        repository: input.input.repository,
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
  if (marker.result === "RESOLVED_BY_MERGED_PR") return "BUG_ACCEPTED"

  return isFinalResult(marker.result) ? marker.result : "FAILED"
}

function isFinalResult(value: unknown): value is FinalResult {
  return (
    value === "ASK" ||
    value === "BUG_ACCEPTED" ||
    value === "BUG_REJECTED" ||
    value === "CLEAR_ONLY" ||
    value === "DUPLICATE" ||
    value === "FEATURE_ACCEPTED" ||
    value === "FEATURE_REJECTED" ||
    value === "FAILED"
  )
}

function actionPlan(input: {
  result: FinalResult
  triage: NonNullable<ResolvedRepository["triage"]>
}): ActionPlan {
  if (input.result === "CLEAR_ONLY") {
    return {
      action: "CLEAR_ONLY",
      allowedActions: ["CLEAR_ONLY"],
      clearLabels: true,
      closeIssue: false,
      createPr: false,
      postComment: false,
    }
  }
  if (input.result === "ASK") {
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
    (input.result === "BUG_REJECTED" ||
      input.result === "DUPLICATE" ||
      input.result === "FEATURE_REJECTED")
  const createPr =
    input.triage.automation.pr &&
    (input.result === "BUG_ACCEPTED" || input.result === "FEATURE_ACCEPTED")

  return {
    action: closeIssue ? "CLOSE" : createPr ? "PR" : "COMMENT",
    allowedActions: [closeIssue ? "CLOSE" : createPr ? "PR" : "COMMENT"],
    clearLabels: true,
    closeIssue,
    createPr,
    postComment: true,
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
}): Promise<TriageFinalVote | undefined> {
  return runPhaseVote<TriageFinalVote>({
    context: input.context,
    input: input.input,
    outputDir: input.outputDir,
    parse: parseTriageFinalOutput,
    phase: "reconsider",
    prompt: composeTriageReconsiderPrompt,
    schemaName: "triage reconsider",
    votes: FINAL_VOTES,
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
  const prompt = await (
    input.result === "ASK"
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
      issue: input.issue.number,
      processed: input.processed,
      result: input.result,
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
    issue: input.issue.number,
    pr: markerPr(input.marker),
    processed: input.processed,
    result: input.marker.result ?? "ASK",
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
  processed?: number[]
  relationship: RelationshipSummary
  result: FinalResult
}): Promise<TriageRunResult> {
  const triage = input.input.repository.triage
  if (!triage) throw new Error("triage configuration is required")
  const plan = actionPlan({ result: input.result, triage })
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
        context: `Result: ${input.result}\nAction: ${plan.action}\n\n${input.context}`,
        input: input.input,
        issue: input.issue,
        outputDir: input.outputDir,
        processed: input.processed,
        result: input.result,
      })
    : undefined

  if (!input.input.dryRun) {
    if (comment) {
      await postMarkedIssueComment({
        account: triage.account ?? "",
        body: comment,
        exec: input.input.exec,
        issue: input.issue.number,
        outputDir: input.outputDir,
        repository: input.input.repository,
      })
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
      if (prUrl)
        await writeJson(join(input.outputDir, "pr.json"), { url: prUrl })
    }
    if (plan.clearLabels) {
      await removeIssueLabels(
        input.input.exec,
        input.input.repository,
        input.issue.number,
        triage.automation.clear,
        triage.account ?? "",
      )
    }
  }

  const report = [
    `Magi triage result for #${input.issue.number}: ${input.result}`,
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

  const branch = `magi/issue-${input.issue.number}-${Date.now().toString(36)}`
  const worktreePath = join(
    worktreeBaseDir(input.input.directory, input.input.config, "issue"),
    `issue-${input.issue.number}`,
  )
  await mkdir(dirname(worktreePath), { recursive: true })
  await input.input.exec(
    `git worktree add -b ${shellQuote(branch)} ${shellQuote(worktreePath)}`,
  )
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
      options: creator.options,
      parse: parseEditOutput,
      permission: creator.permission,
      prompt,
      repairAttempts: 3,
      schemaName: "edit",
      signal: input.input.signal,
      title: `Magi triage create PR #${input.issue.number}`,
    })

    await writeJson(join(input.outputDir, "create-pr.json"), result.value)
    if (result.value.mode !== "EDITED") return undefined

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
        body: `Closes #${input.issue.number}`,
        head: branch,
        title: `fix: address issue #${input.issue.number}`,
      },
    )
  } finally {
    await removeWorktree(input.input.exec, worktreePath).catch(() => undefined)
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

  const issue = await fetchIssue(input.exec, input.repository, input.issue)
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
    return { issue: input.issue, outputDir, report, result: "FAILED" }
  }

  let context = issueContext({ issue, relationship })
  await writeFile(join(outputDir, "context.md"), `${context}\n`)
  let processed = relationship.previousMarker?.processed ?? []
  let result: FinalResult | undefined

  if (relationship.previousMarker) {
    if (!relationship.mentionReplies.length) {
      const result = finalResultFromMarker(relationship.previousMarker)
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
    result =
      (await runReconsiderationVote({ context, input, outputDir })) ?? "ASK"
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
        const plan: ActionPlan = {
          action: "CLOSE",
          allowedActions: ["CLOSE"],
          clearLabels: true,
          closeIssue: true,
          createPr: false,
          postComment: true,
        }
        await runActionPrompt({
          context,
          input,
          outputDir,
          plan,
          result: "BUG_ACCEPTED",
        })
        const body = await composeResultComment({
          action: "CLOSE",
          context: `Result: BUG_ACCEPTED\nAction: CLOSE\n\n${context}`,
          input,
          issue,
          outputDir,
          processed,
          result: "BUG_ACCEPTED",
        })
        if (!input.dryRun) {
          await postMarkedIssueComment({
            account: triage.account,
            body,
            exec: input.exec,
            issue: issue.number,
            outputDir,
            repository: input.repository,
          })
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
          await removeIssueLabels(
            input.exec,
            input.repository,
            issue.number,
            triage.automation.clear,
            triage.account,
          )
        }
        const report = `Magi triage closed #${issue.number} because a related PR was merged.`
        await writeFile(join(outputDir, "report.md"), `${report}\n`)
        return {
          issue: issue.number,
          outputDir,
          report,
          result: "BUG_ACCEPTED",
        }
      }
      return finishWithResult({
        context,
        input,
        issue,
        outputDir,
        processed,
        relationship,
        result: "CLEAR_ONLY",
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
      result = "DUPLICATE"
    }
  }

  if (!result) {
    const resolvedKind = resolveIssueKind(issue, input.repository)
    await writeJson(join(outputDir, "kind-resolution.json"), {
      kind: resolvedKind,
      source: resolvedKind ? "config" : "vote",
    })
    const kind =
      resolvedKind ??
      (await runPhaseVote<TriageKindVote>({
        context,
        input,
        outputDir,
        parse: parseTriageKindOutput,
        phase: "kind",
        prompt: composeTriageKindPrompt,
        schemaName: "triage kind",
        votes: KIND_VOTES,
      })) ??
      "ASK"

    result = "ASK"
    if (kind === "BUG") {
      const vote = await runPhaseVote<TriageBinaryVote>({
        context,
        input,
        outputDir,
        parse: parseTriageBinaryOutput,
        phase: "bug",
        prompt: composeTriageBugPrompt,
        schemaName: "triage bug",
        votes: BINARY_VOTES,
      })
      result =
        vote === "YES" ? "BUG_ACCEPTED" : vote === "NO" ? "BUG_REJECTED" : "ASK"
    }
    if (kind === "FEATURE") {
      const vote = await runPhaseVote<TriageBinaryVote>({
        context,
        input,
        outputDir,
        parse: parseTriageBinaryOutput,
        phase: "feature",
        prompt: composeTriageFeaturePrompt,
        schemaName: "triage feature",
        votes: BINARY_VOTES,
      })
      result =
        vote === "YES"
          ? "FEATURE_ACCEPTED"
          : vote === "NO"
            ? "FEATURE_REJECTED"
            : "ASK"
    }
  }

  return finishWithResult({
    context,
    input,
    issue,
    outputDir,
    processed,
    relationship,
    result: result ?? "ASK",
  })
}
