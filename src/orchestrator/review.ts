import type {
  Exec,
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
  postApproval,
  postChangesRequested,
  postCloseComment,
  postReply,
  type CheckWaitReport,
  type PullRequestReview,
  type PullRequestCommit,
  removeWorktree,
  resolveThread,
} from "../github/commands"
import {
  composeFindingValidationPrompt,
  composeCloseReconsiderationPrompt,
  composeRereviewPrompt,
  composeReviewPrompt,
} from "../prompts/compose"
import { prRunOutputDir } from "../config/output"
import { worktreeBaseDir } from "../config/worktree"
import {
  parseCloseReconsiderationOutput,
  parseFindingValidationOutput,
  parseRereviewOutput,
  parseReviewOutput,
} from "../prompts/output"
import { throwIfAborted, withAbortSignal } from "./abort"
import { waitForChecksWithClassification } from "./ci"
import type { CiClassifierProgress } from "./ci"
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
  key: string
  raw: string
  sessionId: string
  value: RereviewOutput | ReviewOutput
}

type ActiveReviewer = {
  assignment: Exclude<ReviewerAssignment, { type: "skip" }>
  reviewer: ResolvedRepository["agents"]["reviewers"][number]
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

  if (output.verdict === "MERGE")
    return postApproval(
      input.exec,
      input.repository,
      input.pr,
      reviewer.account,
    )

  if (output.verdict === "CLOSE")
    return postCloseComment(
      input.exec,
      input.repository,
      input.pr,
      reviewer.account,
      output.reason ?? "Close requested.",
    )

  return postChangesRequested(
    input.exec,
    input.repository,
    input.pr,
    reviewer.account,
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

  return "CLOSE"
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

function reviewOutputFromState(review: PullRequestReview): ReviewOutput {
  const verdict = reviewStateToVerdict(review.state)

  return verdict === "CLOSE"
    ? { findings: [], reason: review.body || "Close requested.", verdict }
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

async function postRereviewOutput(
  input: ReviewRunInput,
  reviewerKey: string,
  output: RereviewOutput,
): Promise<string> {
  const reviewer = input.repository.agents.reviewers.find(
    (item) => item.key === reviewerKey,
  )

  if (!reviewer) throw new Error(`Unknown reviewer: ${reviewerKey}`)

  await Promise.all(
    output.resolve.map((item) =>
      resolveThread(
        input.exec,
        input.repository,
        reviewer.account,
        item.threadId,
      ),
    ),
  )
  await Promise.all(
    output.followUps.map((item) =>
      postReply(
        input.exec,
        input.repository,
        input.pr,
        reviewer.account,
        item.commentId,
        item.body,
      ),
    ),
  )

  if (output.verdict === "MERGE")
    return postApproval(
      input.exec,
      input.repository,
      input.pr,
      reviewer.account,
    )

  if (output.verdict === "CLOSE")
    return postCloseComment(
      input.exec,
      input.repository,
      input.pr,
      reviewer.account,
      output.reason ?? "Close requested.",
    )

  if (!output.newFindings.length) return ""

  return postChangesRequested(
    input.exec,
    input.repository,
    input.pr,
    reviewer.account,
    output.newFindings.map((finding) => ({
      fix: "Please address this before merging.",
      issue: finding.body,
      line: finding.line,
      path: finding.path,
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
  reviewInput: ReviewRunInput
  sessionIds: Record<string, string>
  worktreePath: string
}): Promise<{
  outputs: Record<string, RereviewOutput | ReviewOutput>
  summary: FindingValidationSummary
}> {
  const reviewOutputs = Object.fromEntries(
    input.entries.flatMap((entry) =>
      isReviewOutput(entry.value) ? [[entry.key, entry.value]] : [],
    ),
  ) as Record<string, ReviewOutput>
  const targets = reviewFindingTargets(reviewOutputs)

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
    outputs: reviewOutputs,
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
    reviewersChangedToMerge: Object.entries(reviewOutputs)
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
      if (!targets.includes(entry.key) || !isReviewOutput(entry.value)) {
        return entry
      }

      const reviewer = input.reviewInput.repository.agents.reviewers.find(
        (item) => item.key === entry.key,
      )

      if (!reviewer) return entry

      const hasReviewerSession = Boolean(input.sessionIds[reviewer.key])
      const prompt = await composeCloseReconsiderationPrompt({
        baseSha: input.meta.baseRefOid,
        ciFailureContext: undefined,
        closeReason: entry.value.reason,
        directory: input.reviewInput.directory,
        headSha: input.meta.headRefOid,
        includeReviewGuidelines: !hasReviewerSession,
        includeSessionContext: !hasReviewerSession,
        pr: input.reviewInput.pr,
        repository: input.reviewInput.repository,
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
            parse: parseCloseReconsiderationOutput,
            permission: reviewer.permission,
            prompt,
            repairAttempts:
              input.reviewInput.config.output?.repairAttempts ?? 3,
            schemaName: "close reconsideration",
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
        key: entry.key,
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
  const reviewerAccounts = input.repository.agents.reviewers.map(
    (reviewer) => reviewer.account,
  )
  const preliminaryMode = resolveReviewMode(
    reviews,
    reviewerAccounts,
    freshnessTarget,
  )
  const unresolvedThreadsByAccount = new Map<
    string,
    Awaited<ReturnType<typeof fetchUnresolvedThreads>>
  >()
  const pendingThreadReplyAccounts = new Set<string>()
  const skippedReviewers = input.repository.agents.reviewers.filter(
    (reviewer) => {
      return preliminaryMode.assignments.get(reviewer.account)?.type === "skip"
    },
  )

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
  const mode = pendingThreadReplyAccounts.size
    ? resolveReviewMode(
        reviews,
        reviewerAccounts,
        freshnessTarget,
        pendingThreadReplyAccounts,
      )
    : preliminaryMode

  if (mode.type === "already_reviewed" && !input.allowAlreadyReviewed)
    throw new Error("PR has already been reviewed by all configured accounts")

  const outputDir = join(
    prRunOutputDir({
      config: input.config,
      directory: input.directory,
      pr: input.pr,
    }),
    ...(input.runId ? [input.runId] : []),
  )

  await mkdir(outputDir, { recursive: true })

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

  const worktreeRoot = worktreeBaseDir(input.directory, input.config, "pr")
  await input.onProgress?.({ phase: "creating worktree", type: "phase" })
  const worktree = await createWorktree(
    exec,
    input.repository,
    input.pr,
    worktreeRoot,
  )
  const worktreePath = worktree.path
  await input.onProgress?.({
    branch: worktree.branch,
    type: "worktree_created",
    worktreePath,
  })

  try {
    throwIfAborted(input.signal)

    const activeReviewers = input.repository.agents.reviewers.flatMap(
      (reviewer): ActiveReviewer[] => {
        const assignment = mode.assignments.get(reviewer.account)

        if (!assignment || assignment.type === "skip") return []

        return [{ assignment, reviewer }]
      },
    )
    for (const reviewer of input.repository.agents.reviewers) {
      const assignment = mode.assignments.get(reviewer.account)
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

          const unresolved =
            unresolvedThreadsByAccount.get(reviewer.account) ??
            (await fetchUnresolvedThreads(
              exec,
              input.repository,
              input.pr,
              reviewer.account,
            ))
          const prompt = await composeRereviewPrompt({
            baseSha: meta.baseRefOid,
            ciFailureContext,
            directory: input.directory,
            headSha: meta.headRefOid,
            pr: input.pr,
            previousReview: previousReviewText(previous),
            previousHeadSha: previous.commit.oid,
            repository: input.repository,
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
                parse: parseRereviewOutput,
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
            key: reviewer.key,
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
          pr: input.pr,
          repository: input.repository,
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
              parse: parseReviewOutput,
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
        const assignment = mode.assignments.get(reviewer.account)

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
        const assignment = mode.assignments.get(reviewer.account)

        if (assignment?.type !== "skip" || !closeTargets.includes(reviewer.key))
          return []

        return [
          {
            key: reviewer.key,
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
      reviewInput: { ...input, exec },
      sessionIds,
      targets: closeTargets,
      worktreePath,
    })
    const validation = await runFindingValidation({
      entries,
      meta,
      outputDir,
      reviewInput: { ...input, exec },
      sessionIds,
      worktreePath,
    })
    const outputs = validation.outputs
    const remainingSkippedVerdicts = input.repository.agents.reviewers.flatMap(
      (reviewer) => {
        const assignment = mode.assignments.get(reviewer.account)

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
    const activeVerdicts = Object.entries(outputs).map(
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
    const posted = {
      ...Object.fromEntries(
        input.repository.agents.reviewers.flatMap((reviewer) => {
          const assignment = mode.assignments.get(reviewer.account)

          return assignment?.type === "skip"
            ? [[reviewer.key, "skipped: already reviewed current head"]]
            : []
        }),
      ),
      ...Object.fromEntries(
        await Promise.all(
          Object.entries(outputs).map(async ([key, output]) => [
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

    const automationAccount = input.repository.agents.reviewers[0]?.account
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
