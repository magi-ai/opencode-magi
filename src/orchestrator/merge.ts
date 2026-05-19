import type {
  EditOutput,
  Exec,
  MagiConfig,
  ModelOptions,
  ResolvedRepository,
  RereviewOutput,
  ReviewOutput,
  Verdict,
} from "../types"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { prRunOutputDir } from "../config/output"
import {
  closePullRequest,
  configureGitIdentity,
  fetchMergeQueueRequirement,
  fetchPullRequest,
  fetchUnresolvedThreads,
  mergePullRequest,
  postApproval,
  postChangesRequested,
  postCloseComment,
  postReply,
  pushHead,
  removeWorktree,
  resolveThread,
  type ReviewThread,
  waitForMergeQueue,
  type CheckWaitReport,
} from "../github/commands"
import {
  composeEditPrompt,
  composeRereviewCloseReconsiderationPrompt,
  composeRereviewPrompt,
} from "../prompts/compose"
import {
  parseEditOutput,
  parseRereviewCloseReconsiderationOutput,
  parseRereviewOutput,
} from "../prompts/output"
import { throwIfAborted, withAbortSignal } from "./abort"
import { waitForChecksWithClassification } from "./ci"
import { closeMinorityReviewers, mergeVerdictForPolicy } from "./majority"
import { type ModelClient, runModelWithRepair } from "./model"
import { mapPool } from "./pool"
import { formatMergeReport } from "./report"
import { runReview, type ReviewRunProgress } from "./review"
import { checkSafetyGate, hasSafetyGate } from "./safety"

export interface MergeRunInput {
  client: ModelClient
  config: MagiConfig
  directory: string
  dryRun?: boolean
  exec: Exec
  onProgress?: (progress: MergeRunProgress) => void | Promise<void>
  pr: number
  repository: ResolvedRepository
  runId?: string
  signal?: AbortSignal
}

export interface MergeRunResult {
  cycles: number
  pr: number
  report: string
  status:
    | "changes_unresolved"
    | "ci_unresolved"
    | "approved"
    | "close_requested"
    | "closed"
    | "dequeued"
    | "merged"
    | "safety_blocked"
}

export type MergeRunProgress =
  | ReviewRunProgress
  | { report: CheckWaitReport; type: "ci_report" }
  | { threads: ThreadLimitNotification[]; type: "thread_limit_reached" }
  | {
      attempts: Record<string, ThreadResolutionAttempt>
      type: "thread_attempts"
    }
  | { cycle: number; type: "editor_completed" }
  | { cycle: number; sessionId: string; type: "editor_response" }
  | { cycle: number; type: "editor_repair" }
  | { cycle: number; error: string; type: "editor_failed" }
  | {
      cycle: number
      options?: ModelOptions
      sessionId: string
      type: "editor_session"
    }
  | { cycle: number; type: "editor_started" }
  | { status: MergeRunResult["status"]; type: "merge_completed" }
  | { message: string; type: "warning" }

export interface ThreadResolutionAttempt {
  attempts: number
  exhaustedAtCycle?: number
  firstSeenCycle: number
  lastAttemptedCycle?: number
  lastSeenCycle: number
}

export interface ThreadLimitNotification {
  label: string
  url: string
}

function outputDir(input: MergeRunInput): string {
  return prRunOutputDir({
    config: input.config,
    directory: input.directory,
    pr: input.pr,
    runId: input.runId,
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function withEditorFailureProgress<T>(input: {
  cycle: number
  onProgress?: (progress: MergeRunProgress) => void | Promise<void>
  run: () => Promise<T>
}): Promise<T> {
  try {
    return await input.run()
  } catch (error) {
    await input.onProgress?.({
      cycle: input.cycle,
      error: errorMessage(error),
      type: "editor_failed",
    })
    throw error
  }
}

async function withReviewerFailureProgress<T>(input: {
  onProgress?: (progress: MergeRunProgress) => void | Promise<void>
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

async function runEditor(
  input: MergeRunInput,
  worktreePath: string,
  cycle: number,
  unresolvedThreads: ReviewThread[],
): Promise<EditOutput> {
  const editor = input.repository.agents.editor

  if (!editor) throw new Error("agents.editor is required for magi_merge")

  throwIfAborted(input.signal)

  await configureGitIdentity(input.exec, worktreePath, {
    email: editor.author?.email,
    name: editor.author?.name,
  })

  const artifactDir = outputDir(input)
  const prompt = await composeEditPrompt({
    directory: input.directory,
    pr: input.pr,
    repository: input.repository,
    unresolvedThreads: JSON.stringify(unresolvedThreads, null, 2),
    worktreePath,
  })
  await input.onProgress?.({ cycle, type: "editor_started" })
  const result = await withEditorFailureProgress({
    cycle,
    onProgress: input.onProgress,
    run: () =>
      runModelWithRepair<EditOutput>({
        client: input.client,
        model: editor.model,
        onProgress: async (progress) => {
          if (progress.type === "session_created") {
            await input.onProgress?.({
              cycle,
              options: progress.options,
              sessionId: progress.sessionId,
              type: "editor_session",
            })
          }
          if (progress.type === "repair") {
            await input.onProgress?.({ cycle, type: "editor_repair" })
          }
          if (progress.type === "response") {
            await input.onProgress?.({
              cycle,
              sessionId: progress.sessionId,
              type: "editor_response",
            })
          }
        },
        options: editor.options,
        parse: parseEditOutput,
        permission: editor.permission,
        prompt,
        repairAttempts: input.config.output?.repairAttempts ?? 3,
        schemaName: "edit",
        signal: input.signal,
        title: `magi edit ${input.repository.alias}#${input.pr} cycle ${cycle}`,
      }),
  })

  await writeFile(join(artifactDir, `editor.cycle-${cycle}.prompt.txt`), prompt)
  await writeFile(
    join(artifactDir, `editor.cycle-${cycle}.raw.txt`),
    result.raw,
  )
  await writeFile(
    join(artifactDir, `editor.cycle-${cycle}.json`),
    JSON.stringify(result.value, null, 2),
  )
  await input.onProgress?.({ cycle, type: "editor_completed" })

  if (!input.dryRun) {
    if (result.value.mode === "EDITED") {
      const meta = await fetchPullRequest(
        input.exec,
        input.repository,
        input.pr,
      )
      const headOwner = meta.headRepositoryOwner?.login
      const headRepo = meta.headRepository?.name

      if (!headOwner || !headRepo) {
        throw new Error("Pull request head repository is missing")
      }

      await pushHead(
        input.exec,
        input.repository,
        worktreePath,
        editor.account,
        { owner: headOwner, ref: meta.headRefName, repo: headRepo },
      )
    }
  }

  throwIfAborted(input.signal)

  if (!input.dryRun) {
    await Promise.all(
      result.value.responses.map((reply) =>
        postReply(
          input.exec,
          input.repository,
          input.pr,
          editor.account,
          reply.commentId,
          reply.body,
        ),
      ),
    )
  }

  return result.value
}

async function postRereviewOutput(
  input: MergeRunInput,
  reviewerKey: string,
  output: RereviewOutput,
): Promise<string> {
  const reviewer = input.repository.agents.reviewers.find(
    (item) => item.key === reviewerKey,
  )

  if (!reviewer) throw new Error(`Unknown reviewer: ${reviewerKey}`)

  if (input.dryRun) {
    if (output.verdict === "MERGE")
      return `dry-run:would-approve:${reviewerKey}`
    if (output.verdict === "CLOSE") {
      return `dry-run:would-comment-close:${reviewerKey}`
    }

    return `dry-run:would-request-changes:${reviewerKey}`
  }

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
  const replies = await Promise.all(
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

  if (output.verdict === "MERGE") {
    return postApproval(
      input.exec,
      input.repository,
      input.pr,
      reviewer.account,
    )
  }

  if (output.verdict === "CLOSE") {
    return postCloseComment(
      input.exec,
      input.repository,
      input.pr,
      reviewer.account,
      output.reason ?? "Close requested.",
    )
  }

  if (output.newFindings.length) {
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

  return replies[0] ?? ""
}

async function runRereview(
  input: MergeRunInput,
  worktreePath: string,
  previousHeadSha: string,
  cycle: number,
  sessionIds: Record<string, string>,
  ciFailureContext: string,
  options: {
    dryRunHeadSha?: string
    dryRunThreads?: Record<string, ReviewThread[]>
  } = {},
): Promise<{
  outputs: Record<string, RereviewOutput>
  posted: Record<string, string>
  verdict: Verdict
}> {
  throwIfAborted(input.signal)

  const meta = await fetchPullRequest(input.exec, input.repository, input.pr)
  const headSha = options.dryRunHeadSha ?? meta.headRefOid
  const artifactDir = outputDir(input)
  let entries = await mapPool(
    input.repository.agents.reviewers,
    input.repository.concurrency.reviewers,
    async (reviewer) => {
      throwIfAborted(input.signal)

      const unresolved =
        options.dryRunThreads?.[reviewer.key] ??
        (await fetchUnresolvedThreads(
          input.exec,
          input.repository,
          input.pr,
          reviewer.account,
        ))
      const hasReviewerSession = Boolean(sessionIds[reviewer.key])
      const prompt = await composeRereviewPrompt({
        baseSha: meta.baseRefOid,
        ciFailureContext,
        directory: input.directory,
        headSha,
        includeReviewGuidelines: !hasReviewerSession,
        includeSessionContext: !hasReviewerSession,
        pr: input.pr,
        previousHeadSha,
        repository: input.repository,
        reviewer,
        unresolvedThreads: JSON.stringify(unresolved, null, 2),
        worktreePath,
      })
      await input.onProgress?.({
        reviewer: reviewer.key,
        type: "reviewer_started",
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
            sessionId: sessionIds[reviewer.key],
            title: `magi rereview ${input.repository.alias}#${input.pr} ${reviewer.key} cycle ${cycle}`,
          }),
      })

      sessionIds[reviewer.key] = result.sessionId

      await writeFile(
        join(artifactDir, `${reviewer.key}.rereview.cycle-${cycle}.prompt.txt`),
        prompt,
      )
      await writeFile(
        join(artifactDir, `${reviewer.key}.rereview.cycle-${cycle}.raw.txt`),
        result.raw,
      )
      await writeFile(
        join(artifactDir, `${reviewer.key}.rereview.cycle-${cycle}.json`),
        JSON.stringify(result.value, null, 2),
      )
      await input.onProgress?.({
        reviewer: reviewer.key,
        sessionId: result.sessionId,
        type: "reviewer_completed",
        verdict: result.value.verdict,
      })

      return {
        output: result.value,
        reviewer: reviewer.key,
        sessionId: result.sessionId,
        verdict: result.value.verdict,
      }
    },
    { signal: input.signal },
  )

  const targets = closeMinorityReviewers(entries)

  if (targets.length) {
    await input.onProgress?.({
      phase: `reconsidering close verdicts cycle ${cycle}`,
      type: "phase",
    })

    entries = await Promise.all(
      entries.map(async (entry) => {
        if (!targets.includes(entry.reviewer)) return entry

        const reviewer = input.repository.agents.reviewers.find(
          (item) => item.key === entry.reviewer,
        )

        if (!reviewer) return entry

        const hasReviewerSession = Boolean(sessionIds[reviewer.key])
        const prompt = await composeRereviewCloseReconsiderationPrompt({
          baseSha: meta.baseRefOid,
          closeReason: entry.output.reason,
          directory: input.directory,
          headSha: meta.headRefOid,
          includeReviewGuidelines: !hasReviewerSession,
          includeSessionContext: !hasReviewerSession,
          pr: input.pr,
          previousHeadSha,
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
              parse: parseRereviewCloseReconsiderationOutput,
              permission: reviewer.permission,
              prompt,
              repairAttempts: input.config.output?.repairAttempts ?? 3,
              schemaName: "rereview close reconsideration",
              sessionId: sessionIds[reviewer.key],
              signal: input.signal,
              title: `magi reconsider close ${input.repository.alias}#${input.pr} ${reviewer.key} cycle ${cycle}`,
            }),
        })

        sessionIds[reviewer.key] = result.sessionId

        await writeFile(
          join(
            artifactDir,
            `${reviewer.key}.close-reconsideration.cycle-${cycle}.prompt.txt`,
          ),
          prompt,
        )
        await writeFile(
          join(
            artifactDir,
            `${reviewer.key}.close-reconsideration.cycle-${cycle}.raw.txt`,
          ),
          result.raw,
        )
        await writeFile(
          join(
            artifactDir,
            `${reviewer.key}.close-reconsideration.cycle-${cycle}.json`,
          ),
          JSON.stringify(result.value, null, 2),
        )
        await input.onProgress?.({
          from: "CLOSE",
          reviewer: reviewer.key,
          to: result.value.verdict,
          type: "reviewer_reconsidered",
        })
        await input.onProgress?.({
          reviewer: reviewer.key,
          sessionId: result.sessionId,
          type: "reviewer_completed",
          verdict: result.value.verdict,
        })

        return {
          output: result.value,
          reviewer: reviewer.key,
          sessionId: result.sessionId,
          verdict: result.value.verdict,
        }
      }),
    )
  }

  const posted = Object.fromEntries(
    await Promise.all(
      entries.map(async (entry) => [
        entry.reviewer,
        await postRereviewOutput(input, entry.reviewer, entry.output),
      ]),
    ),
  )

  const verdict = mergeVerdictForPolicy(
    entries.map((entry) => ({
      reviewer: entry.reviewer,
      verdict: entry.verdict,
    })),
    input.repository.merge.approvalPolicy,
  )

  await writeFile(
    join(artifactDir, `rereview-majority.cycle-${cycle}.json`),
    JSON.stringify(
      {
        approvalPolicy: input.repository.merge.approvalPolicy,
        verdict,
        verdicts: entries.map((entry) => ({
          reviewer: entry.reviewer,
          verdict: entry.verdict,
        })),
      },
      null,
      2,
    ),
  )

  return {
    outputs: Object.fromEntries(
      entries.map((entry) => [entry.reviewer, entry.output]),
    ),
    posted,
    verdict,
  }
}

async function finishMergeRun(
  input: MergeRunInput,
  result: Omit<MergeRunResult, "report">,
  reportInput: {
    ciReports: CheckWaitReport[]
    editorOutputs: EditOutput[]
    outputs: Record<string, RereviewOutput | ReviewOutput>
    posted: Record<string, string>
  },
): Promise<MergeRunResult> {
  const report = formatMergeReport({
    ciReports: reportInput.ciReports,
    dryRun: input.dryRun,
    editorOutputs: reportInput.editorOutputs,
    outputs: reportInput.outputs,
    posted: reportInput.posted,
    repository: input.repository,
    status: result.status,
  })

  await writeFile(join(outputDir(input), "report.md"), `${report}\n`)

  return { ...result, report }
}

async function mergeWithQueue(
  input: MergeRunInput,
  exec: Exec,
  editorAccount: string,
): Promise<"dequeued" | "merged"> {
  await mergePullRequest(exec, input.repository, input.pr, editorAccount)

  if (!input.repository.merge.mergeQueue) return "merged"

  return waitForMergeQueue(exec, input.repository, input.pr)
}

export function hasBlockingCiReports(reports: CheckWaitReport[]): boolean {
  return reports.some(
    (report) =>
      report.scopeInside.length || report.scopeOutsideUnresolved.length,
  )
}

function copyThreadAttempts(
  attempts: Record<string, ThreadResolutionAttempt>,
): Record<string, ThreadResolutionAttempt> {
  return Object.fromEntries(
    Object.entries(attempts).map(([key, value]) => [key, { ...value }]),
  )
}

export function reviewThreadKey(
  thread: Pick<ReviewThread, "commentId" | "threadId">,
): string {
  return thread.threadId || `comment:${thread.commentId}`
}

export function recordReviewThreads(input: {
  attempts: Record<string, ThreadResolutionAttempt>
  cycle: number
  threads: ReviewThread[]
}): void {
  for (const thread of input.threads) {
    const key = reviewThreadKey(thread)
    const current = input.attempts[key]

    input.attempts[key] = current
      ? { ...current, lastSeenCycle: input.cycle }
      : {
          attempts: 0,
          firstSeenCycle: input.cycle,
          lastSeenCycle: input.cycle,
        }
  }
}

export function editableReviewThreads(input: {
  attempts: Record<string, ThreadResolutionAttempt>
  maxThreadResolutionCycles: number
  threads: ReviewThread[]
}): ReviewThread[] {
  if (input.maxThreadResolutionCycles === 0) return input.threads

  return input.threads.filter((thread) => {
    const attempt = input.attempts[reviewThreadKey(thread)]

    return !attempt || attempt.attempts < input.maxThreadResolutionCycles
  })
}

export function exhaustedReviewThreads(input: {
  attempts: Record<string, ThreadResolutionAttempt>
  maxThreadResolutionCycles: number
  threads: ReviewThread[]
}): ReviewThread[] {
  if (input.maxThreadResolutionCycles === 0) return []

  return input.threads.filter((thread) => {
    const attempt = input.attempts[reviewThreadKey(thread)]

    return !!attempt && attempt.attempts >= input.maxThreadResolutionCycles
  })
}

export function incrementReviewThreadAttempts(input: {
  attempts: Record<string, ThreadResolutionAttempt>
  cycle: number
  maxThreadResolutionCycles: number
  threads: ReviewThread[]
}): ReviewThread[] {
  const newlyExhausted: ReviewThread[] = []

  for (const thread of input.threads) {
    const key = reviewThreadKey(thread)
    const current = input.attempts[key] ?? {
      attempts: 0,
      firstSeenCycle: input.cycle,
      lastSeenCycle: input.cycle,
    }
    const attempts = current.attempts + 1
    const exhaustedAtCycle =
      input.maxThreadResolutionCycles !== 0 &&
      attempts >= input.maxThreadResolutionCycles &&
      current.exhaustedAtCycle == null
        ? input.cycle
        : current.exhaustedAtCycle

    if (exhaustedAtCycle === input.cycle) newlyExhausted.push(thread)

    input.attempts[key] = {
      ...current,
      attempts,
      exhaustedAtCycle,
      lastAttemptedCycle: input.cycle,
      lastSeenCycle: input.cycle,
    }
  }

  return newlyExhausted
}

export function reviewThreadNotification(
  repository: ResolvedRepository,
  pr: number,
  thread: ReviewThread,
): ThreadLimitNotification {
  const host = repository.github.host || "github.com"

  return {
    label: "GitHub thread",
    url: `https://${host}/${repository.github.owner}/${repository.github.repo}/pull/${pr}#discussion_r${thread.commentId}`,
  }
}

function syntheticReviewThreads(
  outputs: Record<string, RereviewOutput | ReviewOutput>,
): Record<string, ReviewThread[]> {
  let nextCommentId = -1
  const threads: Record<string, ReviewThread[]> = {}

  for (const [reviewer, output] of Object.entries(outputs)) {
    if ("findings" in output) {
      threads[reviewer] = output.findings.map((finding) => {
        const commentId = nextCommentId--

        return {
          body: `Issue: ${finding.issue}\n\nFix: ${finding.fix}`,
          commentId,
          comments: [
            {
              author: reviewer,
              body: `Issue: ${finding.issue}\n\nFix: ${finding.fix}`,
              commentId,
              createdAt: new Date(0).toISOString(),
            },
          ],
          line: finding.line,
          path: finding.path,
          threadId: `dry-run:${reviewer}:${Math.abs(commentId)}`,
        }
      })
      continue
    }

    threads[reviewer] = output.newFindings.map((finding) => {
      const commentId = nextCommentId--

      return {
        body: finding.body,
        commentId,
        comments: [
          {
            author: reviewer,
            body: finding.body,
            commentId,
            createdAt: new Date(0).toISOString(),
          },
        ],
        line: finding.line,
        path: finding.path,
        threadId: `dry-run:${reviewer}:${Math.abs(commentId)}`,
      }
    })
  }

  return threads
}

function flattenSyntheticThreads(
  threads: Record<string, ReviewThread[]>,
): ReviewThread[] {
  return Object.values(threads).flat()
}

function appendDryRunEditorResponses(input: {
  author: string
  output: EditOutput
  threads: Record<string, ReviewThread[]> | undefined
}): Record<string, ReviewThread[]> | undefined {
  if (!input.threads || !input.output.responses.length) return input.threads

  let nextCommentId = -10_000
  const responses = [...input.output.responses]

  return Object.fromEntries(
    Object.entries(input.threads).map(([reviewer, threads]) => [
      reviewer,
      threads.map((thread) => {
        const matched = responses.filter(
          (response) =>
            response.commentId === thread.commentId ||
            thread.comments.some(
              (comment) => comment.commentId === response.commentId,
            ),
        )

        if (!matched.length) return thread

        return {
          ...thread,
          comments: [
            ...thread.comments,
            ...matched.map((response, index) => ({
              author: input.author,
              body: response.body,
              commentId: nextCommentId--,
              createdAt: `9999-01-01T00:00:${String(index).padStart(2, "0")}Z`,
            })),
          ],
        }
      }),
    ]),
  )
}

export async function runMerge(input: MergeRunInput): Promise<MergeRunResult> {
  const exec = withAbortSignal(input.exec, input.signal)
  const abortableInput = { ...input, exec }
  const editor = input.repository.agents.editor

  if (!editor) throw new Error("agents.editor is required for magi_merge")

  throwIfAborted(input.signal)

  const artifactDir = outputDir(input)

  await mkdir(artifactDir, { recursive: true })

  if (hasSafetyGate(input.repository)) {
    await input.onProgress?.({ phase: "checking safety", type: "phase" })
    const safety = await checkSafetyGate({
      exec,
      pr: input.pr,
      repository: input.repository,
    })

    if (!safety.ok) {
      const report = formatMergeReport({
        ciReports: [],
        dryRun: input.dryRun,
        editorOutputs: [],
        outputs: {},
        posted: {},
        repository: input.repository,
        safety,
        status: "safety_blocked",
      })
      await writeFile(join(artifactDir, "report.md"), `${report}\n`)
      await input.onProgress?.({
        status: "safety_blocked",
        type: "merge_completed",
      })

      return { cycles: 0, pr: input.pr, report, status: "safety_blocked" }
    }
  }

  if (input.repository.merge.mergeQueue) {
    const meta = await fetchPullRequest(exec, input.repository, input.pr)
    const requiresMergeQueue = await fetchMergeQueueRequirement(
      exec,
      input.repository,
      meta.baseRefName,
    ).catch(() => undefined)

    if (requiresMergeQueue !== true) {
      await input.onProgress?.({
        message:
          requiresMergeQueue === false
            ? `Merge queue is not enabled for base branch ${meta.baseRefName}.`
            : `Could not verify merge queue for base branch ${meta.baseRefName}.`,
        type: "warning",
      })
    }
  }

  await input.onProgress?.({ phase: "initial review", type: "phase" })
  const review = await runReview({
    ...abortableInput,
    allowAlreadyReviewed: true,
    approvalPolicy: input.repository.merge.approvalPolicy,
    onProgress: (progress) => input.onProgress?.(progress),
    runId: input.runId,
    dryRun: input.dryRun,
    skipSafety: true,
  })

  try {
    throwIfAborted(input.signal)

    let reportOutputs = review.outputs
    let reportPosted = review.posted
    let reportCiReports = review.ciReports
    const editorOutputs: EditOutput[] = []
    const complete = (result: Omit<MergeRunResult, "report">) =>
      finishMergeRun(input, result, {
        ciReports: reportCiReports,
        editorOutputs,
        outputs: reportOutputs,
        posted: reportPosted,
      })

    if (review.verdict === "SAFETY_BLOCKED") {
      await input.onProgress?.({
        status: "safety_blocked",
        type: "merge_completed",
      })
      return complete({ cycles: 0, pr: input.pr, status: "safety_blocked" })
    }

    if (review.verdict === "CLOSE") {
      if (!input.repository.automation.close || input.dryRun) {
        await input.onProgress?.({
          status: "close_requested",
          type: "merge_completed",
        })
        return complete({ cycles: 0, pr: input.pr, status: "close_requested" })
      }

      await input.onProgress?.({ phase: "closing PR", type: "phase" })
      await closePullRequest(exec, input.repository, input.pr, editor.account)
      await input.onProgress?.({ status: "closed", type: "merge_completed" })
      return complete({ cycles: 0, pr: input.pr, status: "closed" })
    }

    if (review.verdict === "MERGE") {
      if (hasBlockingCiReports(review.ciReports)) {
        await input.onProgress?.({
          status: "ci_unresolved",
          type: "merge_completed",
        })
        return complete({ cycles: 0, pr: input.pr, status: "ci_unresolved" })
      }

      if (!input.repository.automation.merge || input.dryRun) {
        await input.onProgress?.({
          status: "approved",
          type: "merge_completed",
        })
        return complete({ cycles: 0, pr: input.pr, status: "approved" })
      }

      await input.onProgress?.({ phase: "merging PR", type: "phase" })
      const status = await mergeWithQueue(input, exec, editor.account)
      await input.onProgress?.({ status, type: "merge_completed" })
      return complete({ cycles: 0, pr: input.pr, status })
    }

    let previousHeadSha = review.headSha
    const ciReports = [...review.ciReports]
    const threadAttempts: Record<string, ThreadResolutionAttempt> = {}
    let dryRunThreads = input.dryRun
      ? syntheticReviewThreads(reportOutputs)
      : undefined

    for (let cycle = 1; ; cycle += 1) {
      const unresolvedThreads = input.dryRun
        ? flattenSyntheticThreads(dryRunThreads ?? {})
        : await fetchUnresolvedThreads(exec, input.repository, input.pr)
      recordReviewThreads({
        attempts: threadAttempts,
        cycle,
        threads: unresolvedThreads,
      })
      await input.onProgress?.({
        attempts: copyThreadAttempts(threadAttempts),
        type: "thread_attempts",
      })

      const editableThreads = editableReviewThreads({
        attempts: threadAttempts,
        maxThreadResolutionCycles:
          input.repository.merge.maxThreadResolutionCycles,
        threads: unresolvedThreads,
      })

      if (!editableThreads.length) {
        await input.onProgress?.({
          status: "changes_unresolved",
          type: "merge_completed",
        })
        return complete({
          cycles: cycle - 1,
          pr: input.pr,
          status: "changes_unresolved",
        })
      }

      await input.onProgress?.({
        phase: `editing cycle ${cycle}`,
        type: "phase",
      })
      const newlyExhausted = incrementReviewThreadAttempts({
        attempts: threadAttempts,
        cycle,
        maxThreadResolutionCycles:
          input.repository.merge.maxThreadResolutionCycles,
        threads: editableThreads,
      })
      await input.onProgress?.({
        attempts: copyThreadAttempts(threadAttempts),
        type: "thread_attempts",
      })
      if (!review.worktreePath) throw new Error("Review worktree is missing")
      const editorOutput = await runEditor(
        abortableInput,
        review.worktreePath,
        cycle,
        editableThreads,
      )
      editorOutputs.push(editorOutput)
      dryRunThreads = input.dryRun
        ? appendDryRunEditorResponses({
            author: editor.account,
            output: editorOutput,
            threads: dryRunThreads,
          })
        : dryRunThreads
      if (newlyExhausted.length) {
        await input.onProgress?.({
          threads: newlyExhausted.map((thread) =>
            reviewThreadNotification(input.repository, input.pr, thread),
          ),
          type: "thread_limit_reached",
        })
      }
      let ciFailureContext = ""
      let reviewHeadSha = previousHeadSha

      if (editorOutput.mode === "EDITED") {
        ciReports.length = 0
        const editedHeadSha = input.dryRun
          ? editorOutput.commitSha
          : (await fetchPullRequest(exec, input.repository, input.pr))
              .headRefOid

        if (!editedHeadSha)
          throw new Error("Editor output did not include commitSha")

        reviewHeadSha = editedHeadSha

        if (input.dryRun) {
          await input.onProgress?.({
            message:
              "Dry run skipped post-edit CI because editor changes were not pushed.",
            type: "warning",
          })
        } else {
          await input.onProgress?.({
            phase: `waiting for checks after edit cycle ${cycle}`,
            type: "phase",
          })
          const checkResult = await waitForChecksWithClassification({
            afterEdit: {
              cycle,
              headSha: editedHeadSha,
              previousHeadSha,
              worktreePath: review.worktreePath,
            },
            client: input.client,
            directory: input.directory,
            exec,
            headSha: editedHeadSha,
            onProgress: (phase) => input.onProgress?.({ phase, type: "phase" }),
            pr: input.pr,
            repairAttempts: input.config.output?.repairAttempts ?? 3,
            repository: input.repository,
            signal: input.signal,
            wait: input.repository.checks.waitAfterEdit,
          })
          ciFailureContext = checkResult?.ciFailureContext ?? ""

          if (
            checkResult &&
            (checkResult.report.scopeOutsideRecovered.length ||
              checkResult.report.scopeOutsideUnresolved.length ||
              checkResult.report.scopeInside.length)
          ) {
            ciReports.push(checkResult.report)
            await input.onProgress?.({
              report: checkResult.report,
              type: "ci_report",
            })
          }
        }
      }

      await input.onProgress?.({
        phase: `rereview cycle ${cycle}`,
        type: "phase",
      })
      reportCiReports = [...ciReports]
      const rereview = await runRereview(
        abortableInput,
        review.worktreePath,
        previousHeadSha,
        cycle,
        review.sessionIds,
        ciFailureContext,
        {
          dryRunHeadSha: input.dryRun ? reviewHeadSha : undefined,
          dryRunThreads,
        },
      )
      reportOutputs = rereview.outputs
      reportPosted = rereview.posted
      dryRunThreads = input.dryRun
        ? syntheticReviewThreads(reportOutputs)
        : undefined
      previousHeadSha = input.dryRun
        ? reviewHeadSha
        : (await fetchPullRequest(exec, input.repository, input.pr)).headRefOid

      if (rereview.verdict === "MERGE") {
        const remainingThreads = input.dryRun
          ? flattenSyntheticThreads(dryRunThreads ?? {})
          : await fetchUnresolvedThreads(exec, input.repository, input.pr)
        recordReviewThreads({
          attempts: threadAttempts,
          cycle,
          threads: remainingThreads,
        })
        await input.onProgress?.({
          attempts: copyThreadAttempts(threadAttempts),
          type: "thread_attempts",
        })
        if (
          exhaustedReviewThreads({
            attempts: threadAttempts,
            maxThreadResolutionCycles:
              input.repository.merge.maxThreadResolutionCycles,
            threads: remainingThreads,
          }).length
        ) {
          await input.onProgress?.({
            status: "changes_unresolved",
            type: "merge_completed",
          })
          return complete({
            cycles: cycle,
            pr: input.pr,
            status: "changes_unresolved",
          })
        }

        if (hasBlockingCiReports(ciReports)) {
          await input.onProgress?.({
            status: "ci_unresolved",
            type: "merge_completed",
          })
          return complete({
            cycles: cycle,
            pr: input.pr,
            status: "ci_unresolved",
          })
        }

        if (!input.repository.automation.merge || input.dryRun) {
          await input.onProgress?.({
            status: "approved",
            type: "merge_completed",
          })
          return complete({ cycles: cycle, pr: input.pr, status: "approved" })
        }

        await input.onProgress?.({ phase: "merging PR", type: "phase" })
        const status = await mergeWithQueue(input, exec, editor.account)
        await input.onProgress?.({ status, type: "merge_completed" })
        return complete({ cycles: cycle, pr: input.pr, status })
      }

      if (rereview.verdict === "CLOSE") {
        if (!input.repository.automation.close || input.dryRun) {
          await input.onProgress?.({
            status: "close_requested",
            type: "merge_completed",
          })
          return complete({
            cycles: cycle,
            pr: input.pr,
            status: "close_requested",
          })
        }

        await input.onProgress?.({ phase: "closing PR", type: "phase" })
        await closePullRequest(exec, input.repository, input.pr, editor.account)
        await input.onProgress?.({ status: "closed", type: "merge_completed" })
        return complete({ cycles: cycle, pr: input.pr, status: "closed" })
      }
    }
  } finally {
    if (review.worktreePath) {
      await removeWorktree(input.exec, review.worktreePath).catch(
        () => undefined,
      )
    }
  }
}
