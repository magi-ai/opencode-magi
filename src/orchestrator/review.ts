import type {
  Exec,
  Finding,
  FindingValidationOutput,
  MagiConfig,
  ModelOptions,
  ResolvedRepository,
  RereviewOutput,
  ReviewOutput,
} from "../types"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  createWorktree,
  fetchPullRequest,
  fetchPullRequestCommits,
  fetchPullRequestReviews,
  fetchUnresolvedThreads,
  closePullRequest,
  mergePullRequest,
  ensurePullRequestCommits,
  postApproval,
  postChangesRequested,
  postCloseComment,
  postReply,
  type CheckWaitReport,
  type PullRequestMeta,
  type PullRequestReview,
  type PullRequestCommit,
  type PullRequestCommitRequirement,
  type ReviewThread,
  removeWorktree,
  resolveThread,
  shellQuote,
} from "../github/commands"
import {
  composeFindingValidationPrompt,
  composeCloseReconsiderationPrompt,
  composeRereviewCloseReconsiderationPrompt,
  composeRereviewPrompt,
  composeReviewPrompt,
} from "../prompts/compose"
import { prRunOutputDir } from "../config/output"
import { prRunWorktreeDir } from "../config/worktree"
import {
  parseCloseReconsiderationOutput,
  parseFindingValidationOutput,
  parseRereviewCloseReconsiderationOutput,
  parseRereviewOutput,
  parseReviewOutput,
} from "../prompts/output"
import { throwIfAborted, withAbortSignal } from "./abort"
import { waitForChecksWithClassification } from "./ci"
import type { CiClassifierProgress } from "./ci"
import {
  parseRightSideDiffTargets,
  validateInlineCommentTargets,
  type InlineCommentTargets,
} from "./inline-comments"
import {
  applyFindingValidation,
  type FindingValidationSummary,
  reviewFindingTargets,
  validateFindingVotes,
} from "./findings"
import {
  closeMinorityReviewers,
  mergeVerdictForPolicy,
  type ApprovalPolicy,
} from "./majority"
import { type ModelClient, runModelWithRepair } from "./model"
import { mapPool } from "./pool"
import { formatReviewReport } from "./report"
import {
  buildReviewContextSnapshot,
  renderReviewContext,
} from "./review-context"
import { checkSafetyGate, hasSafetyGate } from "./safety"

export interface ReviewRunInput {
  allowAlreadyReviewed?: boolean
  approvalPolicy?: ApprovalPolicy
  client: ModelClient
  config: MagiConfig
  directory: string
  dryRun?: boolean
  enableReviewAutomation?: boolean
  exec: Exec
  onProgress?: (progress: ReviewRunProgress) => void | Promise<void>
  parentSessionId?: string
  pr: number
  repository: ResolvedRepository
  runId?: string
  skipSafety?: boolean
  signal?: AbortSignal
}

export interface ReviewRunResult {
  baseSha: string
  ciReports: CheckWaitReport[]
  discardedFindings: FindingValidationSummary["discarded"]
  headSha: string
  outputs: Record<string, RereviewOutput | ReviewOutput>
  posted: Record<string, string>
  pr: number
  report: string
  sessionIds: Record<string, string>
  verdict: "MERGE" | "CHANGES_REQUESTED" | "CLOSE" | "SAFETY_BLOCKED"
  worktreePath?: string
}

type CiReviewRunProgress = CiClassifierProgress extends infer Progress
  ? Progress extends { type: infer Type extends string }
    ? { type: `ci_${Type}` } & Omit<Progress, "type">
    : never
  : never

export type ReviewRunProgress =
  | {
      discarded: number
      kept: number
      type: "findings_validated"
      reviewersChangedToMerge: string[]
    }
  | { phase: string; type: "phase" }
  | {
      from: "CLOSE"
      reviewer: string
      to: "CHANGES_REQUESTED" | "MERGE"
      type: "reviewer_reconsidered"
    }
  | { report: CheckWaitReport; type: "ci_report" }
  | CiReviewRunProgress
  | { reviewer: string; sessionId?: string; type: "reviewer_started" }
  | { reviewer: string; type: "reviewer_skipped"; verdict: string }
  | {
      options?: ModelOptions
      reviewer: string
      sessionId: string
      type: "reviewer_session"
    }
  | { reviewer: string; type: "reviewer_repair" }
  | { reviewer: string; sessionId: string; type: "reviewer_response" }
  | { error: string; reviewer: string; type: "reviewer_failed" }
  | {
      reviewer: string
      sessionId: string
      type: "reviewer_completed"
      verdict: string
    }
  | { branch?: string; type: "worktree_created"; worktreePath: string }
  | { type: "completed"; verdict: string }

type ReviewMode =
  | { assignments: Map<string, ReviewerAssignment>; type: "active" }
  | { assignments: Map<string, ReviewerAssignment>; type: "already_reviewed" }

type ReviewerAssignment =
  | { type: "initial" }
  | { review: PullRequestReview; type: "rereview" }
  | { review: PullRequestReview; type: "skip" }

type ReviewEntry = {
  inlineCommentTargets: InlineCommentTargets
  key: string
  previousHeadSha?: string
  raw: string
  sessionId: string
  value: RereviewOutput | ReviewOutput
}

type ActiveReviewer = {
  assignment: Exclude<ReviewerAssignment, { type: "skip" }>
  reviewer: ResolvedRepository["agents"]["reviewers"][number]
}

export interface ReviewMarker {
  head: string
  pr: number
  reviewer: string
  verdict: "CHANGES_REQUESTED" | "CLOSE" | "MERGE"
}

export interface ReviewFindingMarker {
  finding: number
  head: string
  pr: number
  reviewer: string
}

function resolvedReviewMode(
  repository: ResolvedRepository,
): "multi" | "single" {
  return repository.review?.mode === "multi" ? "multi" : "single"
}

export function reviewPostingAccount(
  repository: ResolvedRepository,
  reviewer: ResolvedRepository["agents"]["reviewers"][number],
): string {
  return resolvedReviewMode(repository) === "single"
    ? (repository.review?.account ?? reviewer.account)
    : reviewer.account
}

function reviewAssignmentKey(
  repository: ResolvedRepository,
  reviewer: ResolvedRepository["agents"]["reviewers"][number],
): string {
  return resolvedReviewMode(repository) === "single"
    ? reviewer.key
    : reviewer.account
}

function parseMarkerFields(text: string): Record<string, string> | undefined {
  const fields = Object.fromEntries(
    text
      .trim()
      .split(/\s+/)
      .flatMap((part) => {
        const index = part.indexOf("=")

        return index > 0 ? [[part.slice(0, index), part.slice(index + 1)]] : []
      }),
  )

  return fields.v === "1" && fields.mode === "single" ? fields : undefined
}

function isMarkerVerdict(
  value: string | undefined,
): value is ReviewMarker["verdict"] {
  return value === "CHANGES_REQUESTED" || value === "CLOSE" || value === "MERGE"
}

export function formatReviewMarker(marker: ReviewMarker): string {
  return `<!-- opencode-magi:review v=1 mode=single pr=${marker.pr} reviewer=${marker.reviewer} verdict=${marker.verdict} head=${marker.head} -->`
}

export function parseReviewMarkers(body: string | undefined): ReviewMarker[] {
  const markers: ReviewMarker[] = []
  const regex = /<!--\s*opencode-magi:review\s+([^>]*)-->/g

  for (const match of body?.matchAll(regex) ?? []) {
    const fields = parseMarkerFields(match[1] ?? "")
    const pr = Number(fields?.pr)

    if (
      !fields ||
      !Number.isInteger(pr) ||
      !fields.reviewer ||
      !fields.head ||
      !isMarkerVerdict(fields.verdict)
    ) {
      continue
    }

    markers.push({
      head: fields.head,
      pr,
      reviewer: fields.reviewer,
      verdict: fields.verdict,
    })
  }

  return markers
}

export function formatReviewFindingMarker(marker: ReviewFindingMarker): string {
  return `<!-- opencode-magi:review-finding v=1 mode=single pr=${marker.pr} reviewer=${marker.reviewer} finding=${marker.finding} head=${marker.head} -->`
}

export function parseReviewFindingMarkers(
  body: string | undefined,
): ReviewFindingMarker[] {
  const markers: ReviewFindingMarker[] = []
  const regex = /<!--\s*opencode-magi:review-finding\s+([^>]*)-->/g

  for (const match of body?.matchAll(regex) ?? []) {
    const fields = parseMarkerFields(match[1] ?? "")
    const pr = Number(fields?.pr)
    const finding = Number(fields?.finding)

    if (
      !fields ||
      !Number.isInteger(pr) ||
      !Number.isInteger(finding) ||
      !fields.reviewer ||
      !fields.head
    ) {
      continue
    }

    markers.push({ finding, head: fields.head, pr, reviewer: fields.reviewer })
  }

  return markers
}

function markerReviewState(verdict: ReviewMarker["verdict"]): string {
  if (verdict === "MERGE") return "APPROVED"
  if (verdict === "CHANGES_REQUESTED") return "CHANGES_REQUESTED"

  return "CLOSE"
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function withReviewerFailureProgress<T>(input: {
  onProgress?: (progress: ReviewRunProgress) => void | Promise<void>
  reviewer: string
  run: () => Promise<T>
}): Promise<T> {
  try {
    return await input.run()
  } catch (error) {
    await input.onProgress?.({
      error: errorMessage(error),
      reviewer: input.reviewer,
      type: "reviewer_failed",
    })
    throw error
  }
}

async function postReviewOutput(
  input: ReviewRunInput,
  reviewerKey: string,
  output: ReviewOutput,
): Promise<string> {
  const reviewer = input.repository.agents.reviewers.find(
    (item) => item.key === reviewerKey,
  )

  if (!reviewer) throw new Error(`Unknown reviewer: ${reviewerKey}`)
  const account = reviewPostingAccount(input.repository, reviewer)

  if (output.verdict === "MERGE")
    return postApproval(input.exec, input.repository, input.pr, account)

  if (output.verdict === "CLOSE")
    return postCloseComment(
      input.exec,
      input.repository,
      input.pr,
      account,
      output.reason ?? "Close requested.",
    )

  return postChangesRequested(
    input.exec,
    input.repository,
    input.pr,
    account,
    output.findings,
  )
}

function dryRunReviewPost(
  key: string,
  output: ReviewOutput | RereviewOutput,
): string {
  if (output.verdict === "MERGE") return `dry-run:would-approve:${key}`
  if (output.verdict === "CLOSE") return `dry-run:would-comment-close:${key}`

  return `dry-run:would-request-changes:${key}`
}

function latestReviewsByAccount(
  reviews: PullRequestReview[],
  accounts: string[],
): Map<string, PullRequestReview> {
  const accountSet = new Set(accounts)
  const latest = new Map<string, PullRequestReview>()

  for (const review of reviews) {
    if (!accountSet.has(review.author.login)) continue
    if (review.state === "DISMISSED") continue

    const current = latest.get(review.author.login)

    if (!current || current.submittedAt.localeCompare(review.submittedAt) < 0)
      latest.set(review.author.login, review)
  }

  return latest
}

export function resolveReviewMode(
  reviews: PullRequestReview[],
  accounts: string[],
  current: ReviewFreshnessTarget,
  accountsWithPendingThreadReplies: ReadonlySet<string> = new Set(),
): ReviewMode {
  const latest = latestReviewsByAccount(reviews, accounts)
  const reviewedHead = accounts.every((account) => {
    return (
      isReviewCurrent(latest.get(account), current) &&
      !accountsWithPendingThreadReplies.has(account)
    )
  })

  const assignments = new Map<string, ReviewerAssignment>()

  for (const account of accounts) {
    const review = latest.get(account)

    if (!review) {
      assignments.set(account, { type: "initial" })
      continue
    }

    if (
      isReviewCurrent(review, current) &&
      !accountsWithPendingThreadReplies.has(account)
    ) {
      assignments.set(account, { review, type: "skip" })
      continue
    }

    assignments.set(account, { review, type: "rereview" })
  }

  if (latest.size && reviewedHead)
    return { assignments, type: "already_reviewed" }

  return { assignments, type: "active" }
}

export function resolveSingleAccountReviewMode(input: {
  account: string
  current: ReviewFreshnessTarget
  pendingReviewers?: ReadonlySet<string>
  pr: number
  reviewerKeys: string[]
  reviews: PullRequestReview[]
}): ReviewMode {
  const reviewerKeySet = new Set(input.reviewerKeys)
  const pendingReviewers = input.pendingReviewers ?? new Set<string>()
  const latest = new Map<string, PullRequestReview>()

  for (const review of input.reviews) {
    if (review.author.login !== input.account) continue
    if (review.state === "DISMISSED") continue

    for (const marker of parseReviewMarkers(review.body)) {
      if (marker.pr !== input.pr || !reviewerKeySet.has(marker.reviewer)) {
        continue
      }

      const synthetic = {
        ...review,
        commit: { oid: marker.head },
        comments: (review.comments ?? []).filter((comment) =>
          parseReviewFindingMarkers(comment.body).some(
            (findingMarker) =>
              findingMarker.pr === input.pr &&
              findingMarker.reviewer === marker.reviewer &&
              findingMarker.head === marker.head,
          ),
        ),
        state: markerReviewState(marker.verdict),
      }
      const current = latest.get(marker.reviewer)

      if (
        !current ||
        current.submittedAt.localeCompare(review.submittedAt) < 0
      ) {
        latest.set(marker.reviewer, synthetic)
      }
    }
  }

  const reviewedHead = input.reviewerKeys.every((reviewer) => {
    return (
      isReviewCurrent(latest.get(reviewer), input.current) &&
      !pendingReviewers.has(reviewer)
    )
  })
  const assignments = new Map<string, ReviewerAssignment>()

  for (const reviewer of input.reviewerKeys) {
    const review = latest.get(reviewer)

    if (!review) {
      assignments.set(reviewer, { type: "initial" })
      continue
    }

    if (
      isReviewCurrent(review, input.current) &&
      !pendingReviewers.has(reviewer)
    ) {
      assignments.set(reviewer, { review, type: "skip" })
      continue
    }

    assignments.set(reviewer, { review, type: "rereview" })
  }

  if (latest.size && reviewedHead)
    return { assignments, type: "already_reviewed" }

  return { assignments, type: "active" }
}

export type ReviewFreshnessTarget =
  | { headSha: string; type: "head" }
  | { committedAt: string; fallbackHeadSha: string; type: "timestamp" }

export function reviewFreshnessTarget(
  commits: PullRequestCommit[],
  headSha: string,
): ReviewFreshnessTarget {
  const latestNonMerge = [...commits]
    .reverse()
    .find((commit) => commit.parentCount < 2)

  return latestNonMerge
    ? {
        committedAt: latestNonMerge.committedDate,
        fallbackHeadSha: headSha,
        type: "timestamp",
      }
    : { headSha, type: "head" }
}

function isReviewCurrent(
  review: PullRequestReview | undefined,
  current: ReviewFreshnessTarget,
): boolean {
  if (!review) return false

  if (current.type === "head") return review.commit?.oid === current.headSha

  if (review.submittedAt.localeCompare(current.committedAt) >= 0) return true

  return review.commit?.oid === current.fallbackHeadSha
}

function reviewStateToVerdict(
  state: string,
): "CHANGES_REQUESTED" | "CLOSE" | "MERGE" {
  if (state === "APPROVED") return "MERGE"
  if (state === "CHANGES_REQUESTED") return "CHANGES_REQUESTED"
  if (state === "CLOSE") return "CLOSE"

  throw new Error(`Unsupported GitHub review state: ${state}`)
}

function hasBlockingCiReports(reports: CheckWaitReport[]): boolean {
  return reports.some(
    (report) =>
      report.scopeInside.length || report.scopeOutsideUnresolved.length,
  )
}

function previousReviewText(review: PullRequestReview): string {
  return JSON.stringify(
    {
      body: review.body ?? "",
      commit: review.commit?.oid,
      state: review.state,
      submittedAt: review.submittedAt,
    },
    null,
    2,
  )
}

function parseReviewOutputWithInlineTargets(
  text: string,
  targets: InlineCommentTargets,
): ReviewOutput {
  const output = parseReviewOutput(text)

  validateInlineCommentTargets(output.findings, targets)

  return output
}

function parseRereviewOutputWithInlineTargets(
  text: string,
  targets: InlineCommentTargets,
): RereviewOutput {
  const output = parseRereviewOutput(text)

  validateInlineCommentTargets(output.newFindings, targets, "newFindings")

  return output
}

export async function inlineCommentTargetsForDiff(input: {
  ensure?: {
    fromSource: PullRequestCommitRequirement["source"]
    meta: PullRequestMeta
    repository: ResolvedRepository
    toSource: PullRequestCommitRequirement["source"]
  }
  exec: Exec
  fromSha: string
  range?: "direct" | "merge-base"
  toSha: string
  worktreePath: string
}): Promise<InlineCommentTargets> {
  if (input.ensure) {
    await ensurePullRequestCommits({
      commits: [
        {
          label: "base",
          sha: input.fromSha,
          source: input.ensure.fromSource,
        },
        {
          label: "head",
          sha: input.toSha,
          source: input.ensure.toSource,
        },
      ],
      exec: input.exec,
      meta: input.ensure.meta,
      repository: input.ensure.repository,
      worktreePath: input.worktreePath,
    })
  }

  const diffRange =
    input.range === "direct"
      ? `${shellQuote(input.fromSha)} ${shellQuote(input.toSha)}`
      : `${shellQuote(input.fromSha)}...${shellQuote(input.toSha)}`

  return parseRightSideDiffTargets(
    await input.exec(`git diff --no-ext-diff --unified=3 ${diffRange}`, {
      cwd: input.worktreePath,
    }),
  )
}

function firstTargetLine(
  targets: InlineCommentTargets,
  path: string,
): number | undefined {
  const lines = targets.get(path)

  if (!lines?.size) return undefined

  return [...lines].sort((a, b) => a - b)[0]
}

function mergeInlineCommentTargets(
  left: InlineCommentTargets,
  right: InlineCommentTargets,
): InlineCommentTargets {
  const merged = new Map<string, Set<number>>()

  for (const [path, lines] of [...left, ...right]) {
    const targetLines = merged.get(path) ?? new Set<number>()

    for (const line of lines) targetLines.add(line)
    merged.set(path, targetLines)
  }

  return merged
}

function targetLineSummary(
  targets: InlineCommentTargets,
  path: string,
): string {
  const lines = targets.get(path)

  if (!lines?.size) return "(none)"

  const sorted = [...lines].sort((a, b) => a - b)
  const shown = sorted.slice(0, 12).join(", ")

  return sorted.length > 12 ? `${shown}, ...` : shown
}

function indentedExcerpt(lines: string[]): string {
  return lines
    .slice(0, 24)
    .map((line) => `  ${line}`)
    .join("\n")
}

function parseMergeConflictSections(output: string): {
  excerpt: string
  path: string
}[] {
  const conflictHeaders = new Set([
    "added in both",
    "changed in both",
    "removed in local",
    "removed in remote",
  ])
  const sections: { lines: string[]; paths: Set<string> }[] = []
  let current: { lines: string[]; paths: Set<string> } | undefined

  for (const line of output.split("\n")) {
    if (!line.trim()) continue

    if (
      !line.startsWith(" ") &&
      !line.startsWith("+") &&
      !line.startsWith("-") &&
      !line.startsWith("@")
    ) {
      current = conflictHeaders.has(line)
        ? { lines: [line], paths: new Set() }
        : undefined
      if (current) sections.push(current)
      continue
    }

    if (!current) continue

    current.lines.push(line)

    const path = /^  (?:base|our|their)\s+\d+\s+[0-9a-f]+\s+(.+)$/.exec(
      line,
    )?.[1]
    if (path) current.paths.add(path)
  }

  return sections.flatMap((section) =>
    [...section.paths].map((path) => ({
      excerpt: indentedExcerpt(section.lines),
      path,
    })),
  )
}

export async function mergeConflictContextForDiff(input: {
  baseSha: string
  exec: Exec
  headSha: string
  inlineCommentTargets: InlineCommentTargets
  worktreePath: string
}): Promise<string> {
  const mergeBase = (
    await input.exec(
      `git merge-base ${shellQuote(input.baseSha)} ${shellQuote(input.headSha)}`,
      { cwd: input.worktreePath },
    )
  ).trim()
  const output = await input.exec(
    `git merge-tree ${shellQuote(mergeBase)} ${shellQuote(input.headSha)} ${shellQuote(input.baseSha)}`,
    { cwd: input.worktreePath },
  )
  const conflicts = parseMergeConflictSections(output)

  if (!conflicts.length) return ""

  return [
    "The PR currently has unresolved merge conflicts with the base branch.",
    "Treat unresolved conflicts as review findings and request changes when they make the PR unsafe or impossible to merge.",
    "Use suggestedLine when it is present; it is a valid right-side PR diff line for an inline finding.",
    ...conflicts.map((conflict) => {
      const suggestedLine = firstTargetLine(
        input.inlineCommentTargets,
        conflict.path,
      )
      const suggestedLineText = suggestedLine
        ? `suggestedLine: ${suggestedLine}`
        : "suggestedLine: (no right-side PR diff line found)"

      return `<conflict_file>\npath: ${conflict.path}\n${suggestedLineText}\nrightSideDiffLines: ${targetLineSummary(input.inlineCommentTargets, conflict.path)}\nmergeTreeExcerpt:\n${conflict.excerpt}\n</conflict_file>`
    }),
  ].join("\n")
}

function parsePostedFindingLocation(
  location: string,
): Pick<Finding, "line" | "path" | "startLine"> | undefined {
  const range = /^(.*):(\d+)-(\d+)$/.exec(location)
  if (range) {
    return {
      line: Number(range[3]),
      path: range[1] ?? location,
      startLine: Number(range[2]),
    }
  }

  const line = /^(.*):(\d+)$/.exec(location)
  if (line) return { line: Number(line[2]), path: line[1] ?? location }

  return undefined
}

function reviewFindingsFromBody(
  body: string | undefined,
): Pick<ReviewOutput, "findings"> {
  const findings: Finding[] = []
  const lines = (body ?? "").split(/\r?\n/)
  let section: "finding" | undefined

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]

    if (line === "Inline findings:" || line === "File-level findings:") {
      section = "finding"
      continue
    }
    if (line === "Requirement findings:") {
      section = undefined
      continue
    }

    if (section === "finding") {
      const match = /^- (.*): (.+)$/.exec(line ?? "")
      const fix = /^\s+Fix: (.+)$/.exec(lines[index + 1] ?? "")
      if (!match || !fix) continue
      const location = parsePostedFindingLocation(match[1] ?? "")
      if (!location) continue

      findings.push({
        ...location,
        fix: fix[1] ?? "Please address this before merging.",
        issue: match[2] ?? "Review finding.",
      })
      index += 1
      continue
    }
  }

  return { findings }
}

function parsePostedFindingComment(
  body: string,
): Pick<Finding, "fix" | "issue"> | undefined {
  const visibleBody = body
    .replace(/<!--\s*opencode-magi:review-finding\s+[^>]*-->/g, "")
    .trim()
  const match =
    /^\*\*Issue:\*\*\s*([\s\S]*?)\s*\r?\n\r?\n\*\*Fix:\*\*\s*([\s\S]*?)(?:\s*\r?\n\r?\n\*\*Reviewer:\*\*[\s\S]*)?\s*$/.exec(
      visibleBody,
    )

  if (!match) return undefined

  return {
    fix: match[2]?.trim() || "Please address this before merging.",
    issue: match[1]?.trim() || "Review finding.",
  }
}

function reviewFindingsFromComments(
  comments: PullRequestReview["comments"] | undefined,
): Pick<ReviewOutput, "findings"> {
  return {
    findings: (comments ?? []).flatMap((comment) => {
      if (comment.line == null) return []

      const parsed = parsePostedFindingComment(comment.body)
      if (!parsed) return []

      return [
        {
          ...parsed,
          line: comment.line,
          path: comment.path,
          startLine: comment.startLine ?? undefined,
        },
      ]
    }),
  }
}

export function reviewOutputFromState(review: PullRequestReview): ReviewOutput {
  const verdict = reviewStateToVerdict(review.state)

  if (verdict === "CHANGES_REQUESTED") {
    const fromComments = reviewFindingsFromComments(review.comments)

    if (fromComments.findings.length) return { ...fromComments, verdict }

    return { ...reviewFindingsFromBody(review.body), verdict }
  }

  return verdict === "CLOSE"
    ? {
        findings: [],
        reason: review.body || "Close requested.",
        verdict,
      }
    : { findings: [], verdict }
}

export function hasPendingThreadReply(
  threads: Awaited<ReturnType<typeof fetchUnresolvedThreads>>,
  reviewerAccount: string,
): boolean {
  return threads.some((thread) => {
    const comments = [...thread.comments].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    )
    const latestReviewerComment = comments
      .filter((comment) => comment.author === reviewerAccount)
      .at(-1)

    if (!latestReviewerComment) return false

    return comments.some(
      (comment) =>
        comment.author !== reviewerAccount &&
        comment.createdAt.localeCompare(latestReviewerComment.createdAt) > 0,
    )
  })
}

export function assignThreadsByReviewFindingMarker(input: {
  fallbackReviewerKeys: string[]
  headSha?: string
  pr: number
  reviewerKeys: string[]
  threads: ReviewThread[]
}): Record<string, ReviewThread[]> {
  const reviewerKeys = new Set(input.reviewerKeys)
  const assigned = Object.fromEntries(
    input.reviewerKeys.map((reviewer) => [reviewer, [] as ReviewThread[]]),
  )

  for (const thread of input.threads) {
    const markers = [
      thread.body,
      thread.latestBody,
      ...thread.comments.map((comment) => comment.body),
    ]
      .flatMap(parseReviewFindingMarkers)
      .filter((marker) => {
        return (
          marker.pr === input.pr &&
          reviewerKeys.has(marker.reviewer) &&
          (!input.headSha || marker.head === input.headSha)
        )
      })
    const reviewers = markers.length
      ? [...new Set(markers.map((marker) => marker.reviewer))]
      : input.fallbackReviewerKeys

    for (const reviewer of reviewers) assigned[reviewer]?.push(thread)
  }

  return assigned
}

function outputFindings(
  reviewer: string,
  output: RereviewOutput | ReviewOutput,
): Array<{ finding: Finding; index: number; reviewer: string }> {
  if (output.verdict !== "CHANGES_REQUESTED") return []

  if ("findings" in output) {
    return output.findings.map((finding, index) => ({
      finding,
      index,
      reviewer,
    }))
  }

  return output.newFindings.map((finding, index) => ({
    finding: {
      fix: "Please address this before merging.",
      issue: finding.body,
      line: finding.line,
      path: finding.path,
      startLine: finding.startLine,
    },
    index,
    reviewer,
  }))
}

function singleReviewBody(input: {
  headSha: string
  outputs: Record<string, RereviewOutput | ReviewOutput>
  pr: number
  verdict: "CHANGES_REQUESTED" | "CLOSE" | "MERGE"
}): string {
  const outputs = Object.entries(input.outputs).sort(([a], [b]) =>
    a.localeCompare(b),
  )
  const closeReasons = outputs.flatMap(([reviewer, output]) =>
    output.verdict === "CLOSE"
      ? [`- ${reviewer}: ${output.reason ?? "Close requested."}`]
      : [],
  )
  const acceptedFindings = outputs.flatMap(([reviewer, output]) =>
    outputFindings(reviewer, output).map(({ finding, index }) => {
      const line =
        finding.startLine == null || finding.startLine === finding.line
          ? String(finding.line)
          : `${finding.startLine}-${finding.line}`

      return `- ${reviewer} #${index + 1} ${finding.path}:${line}: ${finding.issue} Fix: ${finding.fix}`
    }),
  )
  const lines = [
    `Magi single-account review result: ${input.verdict}.`,
    "",
    "Logical reviewer verdicts:",
    ...outputs.map(([reviewer, output]) => `- ${reviewer}: ${output.verdict}`),
    ...(input.verdict === "CLOSE" && closeReasons.length
      ? ["", "Close reasons:", ...closeReasons]
      : []),
    ...(input.verdict === "CHANGES_REQUESTED" && acceptedFindings.length
      ? ["", "Accepted change requests:", ...acceptedFindings]
      : []),
    "",
    ...outputs.map(([reviewer, output]) =>
      formatReviewMarker({
        head: input.headSha,
        pr: input.pr,
        reviewer,
        verdict: output.verdict,
      }),
    ),
  ]

  return lines.join("\n")
}

function singleFindingBody(input: {
  finding: Finding
  headSha: string
  index: number
  pr: number
  reviewer: string
}): string {
  return [
    `**Issue:** ${input.finding.issue}`,
    "",
    `**Fix:** ${input.finding.fix}`,
    "",
    `**Reviewer:** ${input.reviewer}`,
    "",
    formatReviewFindingMarker({
      finding: input.index,
      head: input.headSha,
      pr: input.pr,
      reviewer: input.reviewer,
    }),
  ].join("\n")
}

export async function postSingleConsensusReview(input: {
  exec: Exec
  headSha: string
  outputs: Record<string, RereviewOutput | ReviewOutput>
  pr: number
  repository: ResolvedRepository
  verdict: "CHANGES_REQUESTED" | "CLOSE" | "MERGE"
}): Promise<string> {
  const account = input.repository.review?.account

  if (!account)
    throw new Error("review.account is required for single review mode")

  const body = singleReviewBody(input)

  if (input.verdict === "MERGE") {
    return postApproval(input.exec, input.repository, input.pr, account, body)
  }

  if (input.verdict === "CLOSE") {
    return postCloseComment(
      input.exec,
      input.repository,
      input.pr,
      account,
      body,
    )
  }

  const findings = Object.entries(input.outputs).flatMap(([reviewer, output]) =>
    outputFindings(reviewer, output),
  )

  return postChangesRequested(
    input.exec,
    input.repository,
    input.pr,
    account,
    findings.map((item) => item.finding),
    {
      body,
      commentBodies: findings.map((item) =>
        singleFindingBody({
          finding: item.finding,
          headSha: input.headSha,
          index: item.index,
          pr: input.pr,
          reviewer: item.reviewer,
        }),
      ),
    },
  )
}

async function postRereviewOutput(
  input: ReviewRunInput,
  reviewerKey: string,
  output: RereviewOutput,
): Promise<string> {
  const reviewer = input.repository.agents.reviewers.find(
    (item) => item.key === reviewerKey,
  )

  if (!reviewer) throw new Error(`Unknown reviewer: ${reviewerKey}`)
  const account = reviewPostingAccount(input.repository, reviewer)

  await Promise.all(
    output.resolve.map((item) =>
      resolveThread(input.exec, input.repository, account, item.threadId),
    ),
  )
  await Promise.all(
    output.followUps.map((item) =>
      postReply(
        input.exec,
        input.repository,
        input.pr,
        account,
        item.commentId,
        item.body,
      ),
    ),
  )

  if (output.verdict === "MERGE")
    return postApproval(input.exec, input.repository, input.pr, account)

  if (output.verdict === "CLOSE")
    return postCloseComment(
      input.exec,
      input.repository,
      input.pr,
      account,
      output.reason ?? "Close requested.",
    )

  if (!output.newFindings.length) return ""

  return postChangesRequested(
    input.exec,
    input.repository,
    input.pr,
    account,
    output.newFindings.map((finding) => ({
      fix: "Please address this before merging.",
      issue: finding.body,
      path: finding.path,
      line: finding.line,
      startLine: finding.startLine,
    })),
  )
}

function isReviewOutput(
  output: RereviewOutput | ReviewOutput,
): output is ReviewOutput {
  return "findings" in output
}

async function runFindingValidation(input: {
  entries: ReviewEntry[]
  meta: { baseRefOid: string; headRefOid: string }
  outputDir: string
  reviewContext: string
  reviewInput: ReviewRunInput
  sessionIds: Record<string, string>
  worktreePath: string
}): Promise<{
  outputs: Record<string, RereviewOutput | ReviewOutput>
  summary: FindingValidationSummary
}> {
  const outputs = Object.fromEntries(
    input.entries.map((entry) => [entry.key, entry.value]),
  )
  const targets = reviewFindingTargets(outputs)

  if (!targets.length) {
    return {
      outputs: Object.fromEntries(
        input.entries.map((entry) => [entry.key, entry.value]),
      ),
      summary: { discarded: [], kept: [] },
    }
  }

  await input.reviewInput.onProgress?.({
    phase: "validating review findings",
    type: "phase",
  })

  const validations = Object.fromEntries(
    await mapPool(
      input.reviewInput.repository.agents.reviewers,
      input.reviewInput.repository.concurrency.reviewers,
      async (reviewer): Promise<[string, FindingValidationOutput]> => {
        const reviewerTargets = targets.filter(
          (target) => target.reviewer !== reviewer.key,
        )

        if (!reviewerTargets.length) return [reviewer.key, { votes: [] }]

        const hasReviewerSession = Boolean(input.sessionIds[reviewer.key])
        const prompt = await composeFindingValidationPrompt({
          baseSha: input.meta.baseRefOid,
          directory: input.reviewInput.directory,
          findings: JSON.stringify(reviewerTargets, null, 2),
          headSha: input.meta.headRefOid,
          includeReviewGuidelines: !hasReviewerSession,
          includeSessionContext: !hasReviewerSession,
          pr: input.reviewInput.pr,
          repository: input.reviewInput.repository,
          reviewContext: input.reviewContext,
          reviewer,
          worktreePath: input.worktreePath,
        })
        const result = await withReviewerFailureProgress({
          onProgress: input.reviewInput.onProgress,
          reviewer: reviewer.key,
          run: () =>
            runModelWithRepair({
              client: input.reviewInput.client,
              model: reviewer.model,
              onProgress: async (progress) => {
                if (progress.type === "session_created") {
                  await input.reviewInput.onProgress?.({
                    reviewer: reviewer.key,
                    options: progress.options,
                    sessionId: progress.sessionId,
                    type: "reviewer_session",
                  })
                }
                if (progress.type === "repair") {
                  await input.reviewInput.onProgress?.({
                    reviewer: reviewer.key,
                    type: "reviewer_repair",
                  })
                }
                if (progress.type === "response") {
                  await input.reviewInput.onProgress?.({
                    reviewer: reviewer.key,
                    sessionId: progress.sessionId,
                    type: "reviewer_response",
                  })
                }
              },
              options: reviewer.options,
              parentSessionId: input.reviewInput.parentSessionId,
              parse: (text) => {
                const output = parseFindingValidationOutput(text)

                validateFindingVotes({
                  output,
                  targets,
                  validator: reviewer.key,
                })

                return output
              },
              permission: reviewer.permission,
              prompt,
              repairAttempts:
                input.reviewInput.config.output?.repairAttempts ?? 3,
              schemaName: "finding validation",
              sessionId: input.sessionIds[reviewer.key],
              signal: input.reviewInput.signal,
              title: `magi validate findings ${input.reviewInput.repository.alias}#${input.reviewInput.pr} ${reviewer.key}`,
            }),
        })

        await writeFile(
          join(
            input.outputDir,
            `${reviewer.key}.finding-validation.prompt.txt`,
          ),
          prompt,
        )
        await writeFile(
          join(input.outputDir, `${reviewer.key}.finding-validation.raw.txt`),
          result.raw,
        )
        await writeFile(
          join(input.outputDir, `${reviewer.key}.finding-validation.json`),
          JSON.stringify(result.value, null, 2),
        )

        input.sessionIds[reviewer.key] = result.sessionId

        return [reviewer.key, result.value]
      },
      { signal: input.reviewInput.signal },
    ),
  )
  const filtered = applyFindingValidation({
    outputs,
    reviewerKeys: input.reviewInput.repository.agents.reviewers.map(
      (reviewer) => reviewer.key,
    ),
    validations,
  })

  await writeFile(
    join(input.outputDir, "finding-validation.json"),
    JSON.stringify({ validations, ...filtered.summary }, null, 2),
  )

  await input.reviewInput.onProgress?.({
    discarded: filtered.summary.discarded.length,
    kept: filtered.summary.kept.length,
    reviewersChangedToMerge: Object.entries(outputs)
      .filter(([reviewer, output]) => {
        return (
          output.verdict === "CHANGES_REQUESTED" &&
          filtered.outputs[reviewer]?.verdict === "MERGE"
        )
      })
      .map(([reviewer]) => reviewer),
    type: "findings_validated",
  })

  return {
    outputs: Object.fromEntries(
      input.entries.map((entry) => [
        entry.key,
        filtered.outputs[entry.key] ?? entry.value,
      ]),
    ),
    summary: filtered.summary,
  }
}

async function runCloseReconsideration(input: {
  entries: ReviewEntry[]
  meta: { baseRefOid: string; headRefOid: string }
  outputDir: string
  reviewContext: string
  reviewInput: ReviewRunInput
  sessionIds: Record<string, string>
  targets?: string[]
  worktreePath: string
}): Promise<ReviewEntry[]> {
  const targets =
    input.targets ??
    closeMinorityReviewers(
      input.entries.map((entry) => ({
        reviewer: entry.key,
        verdict: entry.value.verdict,
      })),
    )

  if (!targets.length) return input.entries

  await input.reviewInput.onProgress?.({
    phase: "reconsidering close verdicts",
    type: "phase",
  })

  return Promise.all(
    input.entries.map(async (entry) => {
      if (!targets.includes(entry.key)) {
        return entry
      }

      const reviewer = input.reviewInput.repository.agents.reviewers.find(
        (item) => item.key === entry.key,
      )

      if (!reviewer) return entry

      const hasReviewerSession = Boolean(input.sessionIds[reviewer.key])
      const isReviewEntry = isReviewOutput(entry.value)
      let prompt: string

      if (isReviewEntry) {
        prompt = await composeCloseReconsiderationPrompt({
          baseSha: input.meta.baseRefOid,
          ciFailureContext: undefined,
          closeReason: entry.value.reason,
          directory: input.reviewInput.directory,
          headSha: input.meta.headRefOid,
          includeReviewGuidelines: !hasReviewerSession,
          includeSessionContext: !hasReviewerSession,
          pr: input.reviewInput.pr,
          repository: input.reviewInput.repository,
          reviewContext: input.reviewContext,
          reviewer,
          worktreePath: input.worktreePath,
        })
      } else {
        if (!entry.previousHeadSha) {
          throw new Error(
            `Missing previous review commit for ${reviewer.account}`,
          )
        }

        prompt = await composeRereviewCloseReconsiderationPrompt({
          baseSha: input.meta.baseRefOid,
          closeReason: entry.value.reason,
          directory: input.reviewInput.directory,
          headSha: input.meta.headRefOid,
          includeReviewGuidelines: !hasReviewerSession,
          includeSessionContext: !hasReviewerSession,
          pr: input.reviewInput.pr,
          previousHeadSha: entry.previousHeadSha,
          repository: input.reviewInput.repository,
          reviewer,
          worktreePath: input.worktreePath,
        })
      }
      const result = await withReviewerFailureProgress({
        onProgress: input.reviewInput.onProgress,
        reviewer: reviewer.key,
        run: () =>
          runModelWithRepair({
            client: input.reviewInput.client,
            model: reviewer.model,
            onProgress: async (progress) => {
              if (progress.type === "session_created") {
                await input.reviewInput.onProgress?.({
                  reviewer: reviewer.key,
                  options: progress.options,
                  sessionId: progress.sessionId,
                  type: "reviewer_session",
                })
              }
              if (progress.type === "repair") {
                await input.reviewInput.onProgress?.({
                  reviewer: reviewer.key,
                  type: "reviewer_repair",
                })
              }
              if (progress.type === "response") {
                await input.reviewInput.onProgress?.({
                  reviewer: reviewer.key,
                  sessionId: progress.sessionId,
                  type: "reviewer_response",
                })
              }
            },
            options: reviewer.options,
            parentSessionId: input.reviewInput.parentSessionId,
            parse: (text) => {
              const output = isReviewEntry
                ? parseCloseReconsiderationOutput(text)
                : parseRereviewCloseReconsiderationOutput(text)
              const findings =
                "newFindings" in output ? output.newFindings : output.findings

              validateInlineCommentTargets(
                findings,
                entry.inlineCommentTargets,
                "newFindings" in output ? "newFindings" : "findings",
              )

              return output
            },
            permission: reviewer.permission,
            prompt,
            repairAttempts:
              input.reviewInput.config.output?.repairAttempts ?? 3,
            schemaName: isReviewEntry
              ? "close reconsideration"
              : "rereview close reconsideration",
            sessionId: input.sessionIds[reviewer.key],
            signal: input.reviewInput.signal,
            title: `magi reconsider close ${input.reviewInput.repository.alias}#${input.reviewInput.pr} ${reviewer.key}`,
          }),
      })

      await writeFile(
        join(
          input.outputDir,
          `${reviewer.key}.close-reconsideration.prompt.txt`,
        ),
        prompt,
      )
      await writeFile(
        join(input.outputDir, `${reviewer.key}.close-reconsideration.raw.txt`),
        result.raw,
      )
      await writeFile(
        join(input.outputDir, `${reviewer.key}.close-reconsideration.json`),
        JSON.stringify(result.value, null, 2),
      )
      await input.reviewInput.onProgress?.({
        from: "CLOSE",
        reviewer: reviewer.key,
        to: result.value.verdict,
        type: "reviewer_reconsidered",
      })
      await input.reviewInput.onProgress?.({
        reviewer: reviewer.key,
        sessionId: result.sessionId,
        type: "reviewer_completed",
        verdict: result.value.verdict,
      })

      input.sessionIds[reviewer.key] = result.sessionId

      return {
        inlineCommentTargets: entry.inlineCommentTargets,
        key: entry.key,
        previousHeadSha: entry.previousHeadSha,
        raw: result.raw,
        sessionId: result.sessionId,
        value: result.value,
      }
    }),
  )
}

export async function runReview(
  input: ReviewRunInput,
): Promise<ReviewRunResult> {
  const exec = withAbortSignal(input.exec, input.signal)

  throwIfAborted(input.signal)
  await input.onProgress?.({ phase: "fetching PR metadata", type: "phase" })

  const meta = await fetchPullRequest(exec, input.repository, input.pr)

  if (meta.isDraft) throw new Error(`PR #${input.pr} is a draft`)

  if (!input.skipSafety && hasSafetyGate(input.repository)) {
    await input.onProgress?.({ phase: "checking safety", type: "phase" })
    const safety = await checkSafetyGate({
      exec,
      pr: input.pr,
      repository: input.repository,
    })

    if (!safety.ok) {
      const outputDir = prRunOutputDir({
        config: input.config,
        directory: input.directory,
        pr: input.pr,
        runId: input.runId,
      })
      await mkdir(outputDir, { recursive: true })
      const report = formatReviewReport({
        ciReports: [],
        dryRun: input.dryRun,
        outputs: {},
        posted: {},
        pr: input.pr,
        repository: input.repository,
        safety,
      })
      await writeFile(join(outputDir, "report.md"), `${report}\n`)
      await input.onProgress?.({ type: "completed", verdict: "SAFETY_BLOCKED" })

      return {
        baseSha: meta.baseRefOid,
        ciReports: [],
        discardedFindings: [],
        headSha: meta.headRefOid,
        outputs: {},
        posted: {},
        pr: input.pr,
        report,
        sessionIds: {},
        verdict: "SAFETY_BLOCKED",
      }
    }
  }

  await input.onProgress?.({
    phase: "fetching existing reviews",
    type: "phase",
  })
  const reviews = await fetchPullRequestReviews(
    exec,
    input.repository,
    input.pr,
  )
  const commits = await fetchPullRequestCommits(
    exec,
    input.repository,
    input.pr,
  )
  const freshnessTarget = reviewFreshnessTarget(commits, meta.headRefOid)
  const singleReviewMode = resolvedReviewMode(input.repository) === "single"
  const reviewerKeys = input.repository.agents.reviewers.map(
    (reviewer) => reviewer.key,
  )
  const reviewerAccounts = input.repository.agents.reviewers.map(
    (reviewer) => reviewer.account,
  )
  const preliminaryMode = singleReviewMode
    ? resolveSingleAccountReviewMode({
        account: input.repository.review?.account ?? "",
        current: freshnessTarget,
        pr: input.pr,
        reviewerKeys,
        reviews,
      })
    : resolveReviewMode(reviews, reviewerAccounts, freshnessTarget)
  const unresolvedThreadsByAccount = new Map<
    string,
    Awaited<ReturnType<typeof fetchUnresolvedThreads>>
  >()
  const unresolvedThreadsByReviewer = new Map<string, ReviewThread[]>()
  const pendingThreadReplyAccounts = new Set<string>()
  const pendingThreadReplyReviewers = new Set<string>()
  const skippedReviewers = input.repository.agents.reviewers.filter(
    (reviewer) => {
      return (
        preliminaryMode.assignments.get(
          reviewAssignmentKey(input.repository, reviewer),
        )?.type === "skip"
      )
    },
  )

  if (singleReviewMode) {
    const account = input.repository.review?.account ?? ""
    const threads = await fetchUnresolvedThreads(
      exec,
      input.repository,
      input.pr,
      account,
    )
    const assigned = assignThreadsByReviewFindingMarker({
      fallbackReviewerKeys: reviewerKeys,
      pr: input.pr,
      reviewerKeys,
      threads,
    })

    for (const reviewer of input.repository.agents.reviewers) {
      const reviewerThreads = assigned[reviewer.key] ?? []

      unresolvedThreadsByReviewer.set(reviewer.key, reviewerThreads)
      if (preliminaryMode.assignments.get(reviewer.key)?.type !== "skip") {
        continue
      }

      if (hasPendingThreadReply(reviewerThreads, account)) {
        pendingThreadReplyReviewers.add(reviewer.key)
      }
    }
  } else {
    await mapPool(
      skippedReviewers,
      input.repository.concurrency.reviewers,
      async (reviewer) => {
        const threads = await fetchUnresolvedThreads(
          exec,
          input.repository,
          input.pr,
          reviewer.account,
        )

        unresolvedThreadsByAccount.set(reviewer.account, threads)
        if (hasPendingThreadReply(threads, reviewer.account)) {
          pendingThreadReplyAccounts.add(reviewer.account)
        }
      },
      { signal: input.signal },
    )
  }
  const mode = singleReviewMode
    ? pendingThreadReplyReviewers.size
      ? resolveSingleAccountReviewMode({
          account: input.repository.review?.account ?? "",
          current: freshnessTarget,
          pendingReviewers: pendingThreadReplyReviewers,
          pr: input.pr,
          reviewerKeys,
          reviews,
        })
      : preliminaryMode
    : pendingThreadReplyAccounts.size
      ? resolveReviewMode(
          reviews,
          reviewerAccounts,
          freshnessTarget,
          pendingThreadReplyAccounts,
        )
      : preliminaryMode

  if (mode.type === "already_reviewed" && !input.allowAlreadyReviewed)
    throw new Error("PR has already been reviewed by all configured accounts")

  const runId = input.runId ?? `run-${Date.now().toString(36)}`
  const outputDir = prRunOutputDir({
    config: input.config,
    directory: input.directory,
    pr: input.pr,
    runId,
  })

  await mkdir(outputDir, { recursive: true })

  await input.onProgress?.({ phase: "fetching review context", type: "phase" })
  const reviewContextSnapshot = await buildReviewContextSnapshot({
    exec,
    pr: meta,
    repository: input.repository,
  })
  const reviewContext = renderReviewContext(reviewContextSnapshot)
  await writeFile(
    join(outputDir, "review-context.json"),
    JSON.stringify(reviewContextSnapshot, null, 2),
  )
  await writeFile(join(outputDir, "review-context.md"), `${reviewContext}\n`)

  await input.onProgress?.({ phase: "waiting for checks", type: "phase" })
  const checkResult = await waitForChecksWithClassification({
    client: input.client,
    directory: input.directory,
    exec,
    headSha: meta.headRefOid,
    onClassifierProgress: (progress) => {
      if (progress.type === "classifier_started") {
        return input.onProgress?.({
          ...progress,
          type: "ci_classifier_started",
        })
      }
      if (progress.type === "classifier_session") {
        return input.onProgress?.({
          ...progress,
          type: "ci_classifier_session",
        })
      }
      if (progress.type === "classifier_repair") {
        return input.onProgress?.({
          ...progress,
          type: "ci_classifier_repair",
        })
      }
      if (progress.type === "classifier_completed") {
        return input.onProgress?.({
          ...progress,
          type: "ci_classifier_completed",
        })
      }

      return input.onProgress?.({
        ...progress,
        type: "ci_classifier_failed",
      })
    },
    onProgress: (phase) => input.onProgress?.({ phase, type: "phase" }),
    outputDir,
    parentSessionId: input.parentSessionId,
    pr: input.pr,
    repairAttempts: input.config.output?.repairAttempts ?? 3,
    repository: input.repository,
    dryRun: input.dryRun,
    signal: input.signal,
    wait: input.repository.checks.waitBeforeReview,
  })
  const ciFailureContext = checkResult?.ciFailureContext ?? ""
  const ciReports = checkResult ? [checkResult.report] : []

  if (
    checkResult &&
    (checkResult.report.scopeOutsideRecovered.length ||
      checkResult.report.scopeOutsideUnresolved.length ||
      checkResult.report.scopeInside.length)
  ) {
    await input.onProgress?.({ report: checkResult.report, type: "ci_report" })
  }

  const worktreePath = prRunWorktreeDir({
    config: input.config,
    directory: input.directory,
    pr: input.pr,
    runId,
  })
  await input.onProgress?.({ phase: "creating worktree", type: "phase" })
  const worktree = await createWorktree(
    exec,
    input.repository,
    input.pr,
    worktreePath,
  )
  await input.onProgress?.({
    branch: worktree.branch,
    type: "worktree_created",
    worktreePath,
  })

  try {
    throwIfAborted(input.signal)

    const activeReviewers = input.repository.agents.reviewers.flatMap(
      (reviewer): ActiveReviewer[] => {
        const assignment = mode.assignments.get(
          reviewAssignmentKey(input.repository, reviewer),
        )

        if (!assignment || assignment.type === "skip") return []

        return [{ assignment, reviewer }]
      },
    )
    const initialInlineCommentTargets = await inlineCommentTargetsForDiff({
      ensure: {
        fromSource: "base",
        meta,
        repository: input.repository,
        toSource: "head",
      },
      exec,
      fromSha: meta.baseRefOid,
      toSha: meta.headRefOid,
      worktreePath,
    })
    const mergeConflictContext = await mergeConflictContextForDiff({
      baseSha: meta.baseRefOid,
      exec,
      headSha: meta.headRefOid,
      inlineCommentTargets: initialInlineCommentTargets,
      worktreePath,
    })
    for (const reviewer of input.repository.agents.reviewers) {
      const assignment = mode.assignments.get(
        reviewAssignmentKey(input.repository, reviewer),
      )
      if (assignment?.type !== "skip") continue

      await input.onProgress?.({
        reviewer: reviewer.key,
        type: "reviewer_skipped",
        verdict: reviewStateToVerdict(assignment.review.state),
      })
    }
    let entries = await mapPool(
      activeReviewers,
      input.repository.concurrency.reviewers,
      async ({ assignment, reviewer }): Promise<ReviewEntry> => {
        await input.onProgress?.({
          reviewer: reviewer.key,
          type: "reviewer_started",
        })

        if (assignment.type === "rereview") {
          const previous = assignment.review

          if (!previous.commit?.oid)
            throw new Error(
              `Missing previous review commit for ${reviewer.account}`,
            )

          const inlineCommentTargets = await inlineCommentTargetsForDiff({
            ensure: {
              fromSource: "head",
              meta,
              repository: input.repository,
              toSource: "head",
            },
            exec,
            fromSha: previous.commit.oid,
            toSha: meta.headRefOid,
            worktreePath,
          })
          const rereviewInlineCommentTargets = mergeConflictContext
            ? mergeInlineCommentTargets(
                inlineCommentTargets,
                initialInlineCommentTargets,
              )
            : inlineCommentTargets

          const unresolved =
            unresolvedThreadsByReviewer.get(reviewer.key) ??
            unresolvedThreadsByAccount.get(reviewer.account) ??
            (await fetchUnresolvedThreads(
              exec,
              input.repository,
              input.pr,
              reviewPostingAccount(input.repository, reviewer),
            ))
          const prompt = await composeRereviewPrompt({
            baseSha: meta.baseRefOid,
            ciFailureContext,
            directory: input.directory,
            headSha: meta.headRefOid,
            mergeConflictContext,
            pr: input.pr,
            previousReview: previousReviewText(previous),
            previousHeadSha: previous.commit.oid,
            repository: input.repository,
            reviewContext,
            reviewer,
            unresolvedThreads: JSON.stringify(unresolved, null, 2),
            worktreePath,
          })
          const result = await withReviewerFailureProgress({
            onProgress: input.onProgress,
            reviewer: reviewer.key,
            run: () =>
              runModelWithRepair({
                client: input.client,
                model: reviewer.model,
                onProgress: async (progress) => {
                  if (progress.type === "session_created") {
                    await input.onProgress?.({
                      reviewer: reviewer.key,
                      options: progress.options,
                      sessionId: progress.sessionId,
                      type: "reviewer_session",
                    })
                  }
                  if (progress.type === "repair") {
                    await input.onProgress?.({
                      reviewer: reviewer.key,
                      type: "reviewer_repair",
                    })
                  }
                  if (progress.type === "response") {
                    await input.onProgress?.({
                      reviewer: reviewer.key,
                      sessionId: progress.sessionId,
                      type: "reviewer_response",
                    })
                  }
                },
                options: reviewer.options,
                parentSessionId: input.parentSessionId,
                parse: (text) =>
                  parseRereviewOutputWithInlineTargets(
                    text,
                    rereviewInlineCommentTargets,
                  ),
                permission: reviewer.permission,
                prompt,
                repairAttempts: input.config.output?.repairAttempts ?? 3,
                schemaName: "rereview",
                signal: input.signal,
                title: `magi rereview ${input.repository.alias}#${input.pr} ${reviewer.key}`,
              }),
          })

          await writeFile(
            join(outputDir, `${reviewer.key}.rereview.prompt.txt`),
            prompt,
          )
          await writeFile(
            join(outputDir, `${reviewer.key}.rereview.raw.txt`),
            result.raw,
          )
          await writeFile(
            join(outputDir, `${reviewer.key}.rereview.json`),
            JSON.stringify(result.value, null, 2),
          )
          await input.onProgress?.({
            reviewer: reviewer.key,
            sessionId: result.sessionId,
            type: "reviewer_completed",
            verdict: result.value.verdict,
          })

          return {
            inlineCommentTargets,
            key: reviewer.key,
            previousHeadSha: previous.commit.oid,
            raw: result.raw,
            sessionId: result.sessionId,
            value: result.value,
          }
        }

        const prompt = await composeReviewPrompt({
          baseSha: meta.baseRefOid,
          ciFailureContext,
          directory: input.directory,
          headSha: meta.headRefOid,
          mergeConflictContext,
          pr: input.pr,
          repository: input.repository,
          reviewContext,
          reviewer,
          worktreePath,
        })
        const result = await withReviewerFailureProgress({
          onProgress: input.onProgress,
          reviewer: reviewer.key,
          run: () =>
            runModelWithRepair({
              client: input.client,
              model: reviewer.model,
              onProgress: async (progress) => {
                if (progress.type === "session_created") {
                  await input.onProgress?.({
                    reviewer: reviewer.key,
                    options: progress.options,
                    sessionId: progress.sessionId,
                    type: "reviewer_session",
                  })
                }
                if (progress.type === "repair") {
                  await input.onProgress?.({
                    reviewer: reviewer.key,
                    type: "reviewer_repair",
                  })
                }
                if (progress.type === "response") {
                  await input.onProgress?.({
                    reviewer: reviewer.key,
                    sessionId: progress.sessionId,
                    type: "reviewer_response",
                  })
                }
              },
              options: reviewer.options,
              parentSessionId: input.parentSessionId,
              parse: (text) =>
                parseReviewOutputWithInlineTargets(
                  text,
                  initialInlineCommentTargets,
                ),
              permission: reviewer.permission,
              prompt,
              repairAttempts: input.config.output?.repairAttempts ?? 3,
              schemaName: "review",
              signal: input.signal,
              title: `magi review ${input.repository.alias}#${input.pr} ${reviewer.key}`,
            }),
        })

        await writeFile(
          join(outputDir, `${reviewer.key}.review.prompt.txt`),
          prompt,
        )
        await writeFile(
          join(outputDir, `${reviewer.key}.review.raw.txt`),
          result.raw,
        )
        await writeFile(
          join(outputDir, `${reviewer.key}.review.json`),
          JSON.stringify(result.value, null, 2),
        )
        await input.onProgress?.({
          reviewer: reviewer.key,
          sessionId: result.sessionId,
          type: "reviewer_completed",
          verdict: result.value.verdict,
        })

        return {
          inlineCommentTargets: initialInlineCommentTargets,
          key: reviewer.key,
          raw: result.raw,
          sessionId: result.sessionId,
          value: result.value,
        }
      },
      { signal: input.signal },
    )

    throwIfAborted(input.signal)

    const sessionIds = Object.fromEntries(
      entries.map((entry) => [entry.key, entry.sessionId]),
    )
    const skippedVerdicts = input.repository.agents.reviewers.flatMap(
      (reviewer) => {
        const assignment = mode.assignments.get(
          reviewAssignmentKey(input.repository, reviewer),
        )

        if (assignment?.type !== "skip") return []

        return [
          {
            reviewer: reviewer.key,
            verdict: reviewStateToVerdict(assignment.review.state),
          },
        ]
      },
    )
    const closeTargets = closeMinorityReviewers([
      ...skippedVerdicts,
      ...entries.map((entry) => ({
        reviewer: entry.key,
        verdict: entry.value.verdict,
      })),
    ])
    const skippedCloseEntries = input.repository.agents.reviewers.flatMap(
      (reviewer): ReviewEntry[] => {
        const assignment = mode.assignments.get(
          reviewAssignmentKey(input.repository, reviewer),
        )

        if (assignment?.type !== "skip" || !closeTargets.includes(reviewer.key))
          return []

        return [
          {
            key: reviewer.key,
            inlineCommentTargets: initialInlineCommentTargets,
            raw: assignment.review.body ?? "",
            sessionId: "",
            value: reviewOutputFromState(assignment.review),
          },
        ]
      },
    )
    entries = await runCloseReconsideration({
      entries: [...entries, ...skippedCloseEntries],
      meta,
      outputDir,
      reviewContext,
      reviewInput: { ...input, exec },
      sessionIds,
      targets: closeTargets,
      worktreePath,
    })
    const validation = await runFindingValidation({
      entries,
      meta,
      outputDir,
      reviewContext,
      reviewInput: { ...input, exec },
      sessionIds,
      worktreePath,
    })
    const activeOutputs = validation.outputs
    const skippedOutputs = Object.fromEntries(
      input.repository.agents.reviewers.flatMap((reviewer) => {
        const assignment = mode.assignments.get(
          reviewAssignmentKey(input.repository, reviewer),
        )

        return assignment?.type === "skip"
          ? [[reviewer.key, reviewOutputFromState(assignment.review)]]
          : []
      }),
    )
    const outputs = { ...skippedOutputs, ...activeOutputs }
    const remainingSkippedVerdicts = input.repository.agents.reviewers.flatMap(
      (reviewer) => {
        const assignment = mode.assignments.get(
          reviewAssignmentKey(input.repository, reviewer),
        )

        if (assignment?.type !== "skip" || closeTargets.includes(reviewer.key))
          return []

        return [
          {
            reviewer: reviewer.key,
            verdict: reviewStateToVerdict(assignment.review.state),
          },
        ]
      },
    )
    const activeVerdicts = Object.entries(activeOutputs).map(
      ([reviewer, output]) => ({
        reviewer,
        verdict: output.verdict,
      }),
    )
    const verdict = mergeVerdictForPolicy(
      [...remainingSkippedVerdicts, ...activeVerdicts],
      input.approvalPolicy ?? "majority",
    )
    await input.onProgress?.({ phase: "posting reviews", type: "phase" })
    const skippedPosted = Object.fromEntries(
      input.repository.agents.reviewers.flatMap((reviewer) => {
        const assignment = mode.assignments.get(
          reviewAssignmentKey(input.repository, reviewer),
        )

        return assignment?.type === "skip"
          ? [[reviewer.key, "skipped: already reviewed current head"]]
          : []
      }),
    )
    const posted = singleReviewMode
      ? {
          ...skippedPosted,
          ...(Object.keys(activeOutputs).length
            ? {
                consensus: input.dryRun
                  ? `dry-run:would-post-single-review:${verdict}`
                  : await (async () => {
                      const account = input.repository.review?.account ?? ""

                      await Promise.all(
                        Object.values(activeOutputs).flatMap((output) => {
                          if (!("resolve" in output)) return []

                          return output.resolve.map((item) =>
                            resolveThread(
                              exec,
                              input.repository,
                              account,
                              item.threadId,
                            ),
                          )
                        }),
                      )
                      await Promise.all(
                        Object.entries(activeOutputs).flatMap(
                          ([key, output]) => {
                            if (!("followUps" in output)) return []

                            return output.followUps.map((item) =>
                              postReply(
                                exec,
                                input.repository,
                                input.pr,
                                account,
                                item.commentId,
                                [
                                  `**Reviewer:** ${key}`,
                                  "",
                                  item.body,
                                  "",
                                  formatReviewMarker({
                                    head: meta.headRefOid,
                                    pr: input.pr,
                                    reviewer: key,
                                    verdict: output.verdict,
                                  }),
                                ].join("\n"),
                              ),
                            )
                          },
                        ),
                      )

                      return postSingleConsensusReview({
                        exec,
                        headSha: meta.headRefOid,
                        outputs,
                        pr: input.pr,
                        repository: input.repository,
                        verdict,
                      })
                    })(),
              }
            : {}),
        }
      : {
          ...skippedPosted,
          ...Object.fromEntries(
            await Promise.all(
              Object.entries(activeOutputs).map(async ([key, output]) => [
                key,
                input.dryRun
                  ? dryRunReviewPost(key, output)
                  : "resolve" in output
                    ? await postRereviewOutput(
                        { ...input, exec },
                        key,
                        output as RereviewOutput,
                      )
                    : await postReviewOutput(
                        { ...input, exec },
                        key,
                        output as ReviewOutput,
                      ),
              ]),
            ),
          ),
        }

    const automationAccount = singleReviewMode
      ? input.repository.review?.account
      : input.repository.agents.reviewers[0]?.account
    const enableReviewAutomation = input.enableReviewAutomation ?? true
    if (
      enableReviewAutomation &&
      verdict === "MERGE" &&
      input.repository.reviewAutomation?.merge
    ) {
      await input.onProgress?.({ phase: "merging PR", type: "phase" })
      posted.automation = hasBlockingCiReports(ciReports)
        ? "skipped: unresolved CI"
        : input.dryRun
          ? "dry-run:would-merge"
          : automationAccount
            ? await mergePullRequest(
                input.exec,
                input.repository,
                input.pr,
                automationAccount,
              )
            : "skipped: no review automation account"
    }
    if (
      enableReviewAutomation &&
      verdict === "CLOSE" &&
      input.repository.reviewAutomation?.close
    ) {
      await input.onProgress?.({ phase: "closing PR", type: "phase" })
      posted.automation = input.dryRun
        ? "dry-run:would-close"
        : automationAccount
          ? await closePullRequest(
              input.exec,
              input.repository,
              input.pr,
              automationAccount,
            )
          : "skipped: no review automation account"
    }

    await writeFile(
      join(outputDir, "majority.json"),
      JSON.stringify(
        {
          approvalPolicy: input.approvalPolicy ?? "majority",
          verdict,
          verdicts: [...remainingSkippedVerdicts, ...activeVerdicts],
        },
        null,
        2,
      ),
    )
    await writeFile(
      join(outputDir, "sessions.json"),
      JSON.stringify(sessionIds, null, 2),
    )
    await writeFile(
      join(outputDir, "posted.json"),
      JSON.stringify(posted, null, 2),
    )

    const report = formatReviewReport({
      ciReports,
      discardedFindings: validation.summary.discarded,
      dryRun: input.dryRun,
      outputs,
      posted,
      pr: input.pr,
      repository: input.repository,
    })

    await writeFile(join(outputDir, "report.md"), `${report}\n`)

    await input.onProgress?.({ type: "completed", verdict })

    return {
      baseSha: meta.baseRefOid,
      ciReports,
      discardedFindings: validation.summary.discarded,
      headSha: meta.headRefOid,
      outputs,
      posted,
      pr: input.pr,
      report,
      sessionIds,
      verdict,
      worktreePath,
    }
  } catch (error) {
    await removeWorktree(input.exec, worktreePath).catch(() => undefined)
    throw error
  }
}
