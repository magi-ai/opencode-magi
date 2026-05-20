import type { Exec, ResolvedRepository } from "../types"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  applyCheckExclusions,
  checkJobId,
  checkRunId,
  type CheckWaitReport,
  type ClassifiedCheck,
  type CiClassifierRun,
  fetchCheckFailureLog,
  fetchPullRequestChecks,
  fetchWorkflowRunMeta,
  isCancelledCheck,
  isFailedCheck,
  type PullRequestCheck,
  rerunCheckJob,
  watchChecks,
  watchRun,
} from "../github/commands"
import {
  composeCiClassificationAfterEditPrompt,
  composeCiClassificationPrompt,
} from "../prompts/compose"
import { parseCiClassificationOutput } from "../prompts/output"
import { majorityThreshold } from "./majority"
import { type ModelClient, runModelWithRepair } from "./model"
import { mapPool } from "./pool"

interface CheckWithLog {
  check: PullRequestCheck
  evidence: CiFailureEvidence
  jobId?: string
}

interface CiFailureEvidence {
  errorMessages: string[]
  failingFiles: string[]
  failingTests: string[]
  relevantFrames: string[]
  representativeLog: string
}

interface TargetChecks {
  blocking: PullRequestCheck[]
  hasAnyActionCheck: boolean
  hasAnyCheck: boolean
  hasPending: boolean
  hasTargetActionCheck: boolean
}

export type CiClassifierProgress =
  | { promptPath?: string; reviewer: string; type: "classifier_started" }
  | {
      reviewer: string
      runAttempt?: number
      sessionId: string
      type: "classifier_session"
    }
  | { reviewer: string; type: "classifier_repair" }
  | {
      classification: "SCOPE_IN" | "SCOPE_OUT"
      rawPath?: string
      reason: string
      reviewer: string
      sessionId: string
      type: "classifier_completed"
    }
  | { error: string; reviewer: string; type: "classifier_failed" }

export interface CheckWaitResult {
  ciFailureContext: string
  report: CheckWaitReport
}

function cleanLogLine(line: string): string {
  return (
    line
      // oxlint-disable-next-line no-control-regex
      .replaceAll(/\u001B\[[0-9;]*m/g, "")
      .replace(/^\S+\s+UNKNOWN STEP\s+/, "")
      .replace(/^\d{4}-\d{2}-\d{2}T\S+Z\s*/, "")
      .replace(/^##\[error\]/, "")
      .trim()
  )
}

function uniqueLimited(values: string[], limit: number): string[] {
  const seen = new Set<string>()
  const result: string[] = []

  for (const value of values) {
    const clean = value.trim()

    if (!clean || seen.has(clean)) continue
    seen.add(clean)
    result.push(clean)
    if (result.length >= limit) break
  }

  return result
}

function compactRepeated(values: string[], limit: number): string[] {
  const counts = new Map<string, number>()
  const order: string[] = []

  for (const value of values) {
    const clean = value.trim()

    if (!clean) continue
    if (!counts.has(clean)) order.push(clean)
    counts.set(clean, (counts.get(clean) ?? 0) + 1)
  }

  return order.slice(0, limit).map((value) => {
    const count = counts.get(value) ?? 1

    return count > 1 ? `${value} (repeated ${count} times)` : value
  })
}

function representativeLog(lines: string[], maxChars = 2_000): string {
  const selected = uniqueLimited(
    lines.filter((line) => {
      return (
        /\b(error|failed|failure|exception|traceback|panic)\b/i.test(line) ||
        /\b(assertionerror|rangeerror|timeouterror|typeerror)\b/i.test(line) ||
        /\bFAIL(?:ED)?\b/.test(line) ||
        /(?:\u276f|\bat\s+).+\.\w+(?::\d+)/.test(line)
      )
    }),
    40,
  ).join("\n")

  if (selected.length <= maxChars) return selected

  return `${selected.slice(0, maxChars).trimEnd()}\n...`
}

export function extractFailureEvidence(log: string): CiFailureEvidence {
  const lines = log
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map(cleanLogLine)
    .filter(Boolean)
  const files: string[] = []
  const frames: string[] = []
  const errors: string[] = []
  const tests: string[] = []

  for (const line of lines) {
    if (/\bFAIL(?:ED)?\b/.test(line)) tests.push(line)
    if (
      /\b(?:RangeError|TypeError|ReferenceError|SyntaxError|AssertionError|TimeoutError|Error):\s+.+/i.test(
        line,
      )
    ) {
      errors.push(
        line.replace(
          /^.*?((?:RangeError|TypeError|ReferenceError|SyntaxError|AssertionError|TimeoutError|Error):\s+.+)$/i,
          "$1",
        ),
      )
    }
    if (
      /\b(error|failed|failure|exception|traceback|panic|command failed|exit code)\b/i.test(
        line,
      )
    ) {
      errors.push(line)
    }
    if (/(?:\u276f|\bat\s+).+\.\w+(?::\d+)/.test(line)) frames.push(line)

    for (const match of line.matchAll(
      /(?:^|\s)([A-Za-z0-9_./-]+\.(?:cjs|css|jsx|mdx|mjs|scss|tsx|ts|js|vue|svelte))(?::\d+(?::\d+)?)?/g,
    )) {
      files.push(match[1])
    }
  }

  return {
    errorMessages: uniqueLimited(errors, 5),
    failingFiles: uniqueLimited(files, 8),
    failingTests: uniqueLimited(tests, 8),
    relevantFrames: compactRepeated(frames, 8),
    representativeLog: representativeLog(lines),
  }
}

function emptyReport(): CheckWaitReport {
  return {
    attempts: 0,
    classifierRuns: [],
    dryRunRerun: [],
    excluded: [],
    failed: [],
    rerun: [],
    scopeInside: [],
    scopeOutsideRecovered: [],
    scopeOutsideUnresolved: [],
  }
}

export function compactLog(log: string, maxChars = 18_000): string {
  const lines = log.replaceAll("\r\n", "\n").split("\n")
  const patterns = [
    /\b(error|failed|failure|exception|traceback|panic)\b/i,
    /\b(assertionerror|timeouterror|typeerror|referenceerror)\b/i,
    /\b(exit code|exited with|command failed)\b/i,
    /^\s*(FAIL|FAILED)\b/i,
  ]
  const selected = new Map<number, string>()

  function includeRange(start: number, end: number) {
    for (
      let index = Math.max(0, start);
      index < Math.min(lines.length, end);
      index += 1
    ) {
      selected.set(index, lines[index])
    }
  }

  includeRange(0, Math.min(40, lines.length))
  includeRange(Math.max(0, lines.length - 220), lines.length)

  for (let index = 0; index < lines.length; index += 1) {
    if (patterns.some((pattern) => pattern.test(lines[index]))) {
      includeRange(index - 12, index + 35)
    }
  }

  const compacted = [...selected]
    .sort(([left], [right]) => left - right)
    .map(([index, line], position, all) => {
      const previous = all[position - 1]?.[0]
      const prefix = previous != null && index > previous + 1 ? "\n...\n" : ""
      return `${prefix}${line}`
    })
    .join("\n")
    .trim()

  if (compacted.length <= maxChars) return compacted

  return [
    compacted.slice(0, Math.floor(maxChars * 0.35)).trimEnd(),
    "\n... log truncated ...\n",
    compacted.slice(compacted.length - Math.floor(maxChars * 0.65)).trimStart(),
  ].join("")
}

function ciFailureContextForClassified(
  items: CheckWithLog[],
  classified: ClassifiedCheck[],
): string {
  const classifiedByName = new Map(
    classified.map((item) => [item.check.name, item]),
  )
  const sections = items
    .filter((item) => classifiedByName.has(item.check.name))
    .map((item) => {
      const classifiedCheck = classifiedByName.get(item.check.name)
      const evidence = item.evidence
      const lines = [
        `## ${item.check.name} (${item.check.workflow || "unknown workflow"})`,
        `State: ${item.check.state}`,
        item.check.link ? `Link: ${item.check.link}` : "",
        classifiedCheck?.reason
          ? `Classifier reason: ${classifiedCheck.reason}`
          : "",
        evidence.errorMessages.length
          ? `Errors:\n${evidence.errorMessages.map((line) => `- ${line}`).join("\n")}`
          : "",
        evidence.failingFiles.length
          ? `Files mentioned:\n${evidence.failingFiles.map((line) => `- ${line}`).join("\n")}`
          : "",
        evidence.failingTests.length
          ? `Failing tests:\n${evidence.failingTests.map((line) => `- ${line}`).join("\n")}`
          : "",
        evidence.relevantFrames.length
          ? `Relevant frames:\n${evidence.relevantFrames.map((line) => `- ${line}`).join("\n")}`
          : "",
        evidence.representativeLog
          ? `Representative log:\n\`\`\`text\n${evidence.representativeLog}\n\`\`\``
          : "",
      ]

      return lines.filter(Boolean).join("\n")
    })

  if (!sections.length) return ""

  return [
    "CI has scope-in failures that may be caused by this PR.",
    "Use this as a review hint; still inspect the PR diff before reporting findings.",
    "",
    ...sections,
  ].join("\n\n")
}

async function checksWithLogs(
  exec: Exec,
  repository: ResolvedRepository,
  checks: PullRequestCheck[],
): Promise<CheckWithLog[]> {
  return Promise.all(
    checks.map(async (check) => {
      const jobId = checkJobId(check)
      const rawLog = jobId
        ? await fetchCheckFailureLog(exec, repository, jobId).catch(
            (error) =>
              `Could not fetch failed log: ${(error as Error).message}`,
          )
        : "This check is not a GitHub Actions job and cannot be rerun."
      const log = compactLog(rawLog)

      return { check, evidence: extractFailureEvidence(log), jobId }
    }),
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isPendingCheck(check: PullRequestCheck): boolean {
  return (
    check.bucket === "pending" ||
    check.state === "ACTION_REQUIRED" ||
    check.state === "EXPECTED" ||
    check.state === "IN_PROGRESS" ||
    check.state === "PENDING" ||
    check.state === "QUEUED" ||
    check.state === "REQUESTED" ||
    check.state === "WAITING"
  )
}

function cancelledClassification(check: PullRequestCheck): ClassifiedCheck {
  return {
    check,
    classification: "SCOPE_OUT",
    reason: "Check was cancelled; rerun without CI scope classification.",
  }
}

async function watchRerunRuns(
  exec: Exec,
  repository: ResolvedRepository,
  checks: ClassifiedCheck[],
): Promise<void> {
  const runIds = [
    ...new Set(
      checks.flatMap((item) => {
        const runId = checkRunId(item.check)

        return runId ? [runId] : []
      }),
    ),
  ]

  await Promise.all(runIds.map((runId) => watchRun(exec, repository, runId)))
}

async function checksForHead(input: {
  exec: Exec
  headSha?: string
  pr: number
  repository: ResolvedRepository
  runHeadCache: Map<string, Promise<string | undefined>>
}): Promise<TargetChecks> {
  const checks = await fetchPullRequestChecks(
    input.exec,
    input.repository,
    input.pr,
    { tolerateMissingChecks: Boolean(input.headSha) },
  )
  const targetChecks: PullRequestCheck[] = []
  let hasAnyActionCheck = false
  let hasTargetActionCheck = false

  for (const check of checks) {
    const runId = checkRunId(check)

    if (!input.headSha || !runId) {
      targetChecks.push(check)
      continue
    }

    hasAnyActionCheck = true
    const runHead = await runHeadSha({
      exec: input.exec,
      repository: input.repository,
      runHeadCache: input.runHeadCache,
      runId,
    })

    if (runHead === input.headSha) {
      hasTargetActionCheck = true
      targetChecks.push(check)
    }
  }

  return {
    blocking: targetChecks.filter(
      (check) => isFailedCheck(check) || isCancelledCheck(check),
    ),
    hasAnyActionCheck,
    hasAnyCheck: checks.length > 0,
    hasPending: targetChecks.some(isPendingCheck),
    hasTargetActionCheck,
  }
}

function runHeadSha(input: {
  exec: Exec
  repository: ResolvedRepository
  runHeadCache: Map<string, Promise<string | undefined>>
  runId: string
}): Promise<string | undefined> {
  const cached = input.runHeadCache.get(input.runId)
  if (cached) return cached

  const promise = fetchWorkflowRunMeta(
    input.exec,
    input.repository,
    input.runId,
  )
    .then((run) => run.headSha || undefined)
    .catch(() => undefined)

  input.runHeadCache.set(input.runId, promise)

  return promise
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function classifyChecks(input: {
  afterEdit?: {
    cycle: number
    headSha: string
    previousHeadSha: string
    worktreePath: string
  }
  checks: CheckWithLog[]
  client: ModelClient
  directory: string
  onClassifierProgress?: (
    progress: CiClassifierProgress,
  ) => void | Promise<void>
  outputDir?: string
  pr: number
  repository: ResolvedRepository
  repairAttempts: number
  signal?: AbortSignal
}): Promise<{
  classified: ClassifiedCheck[]
  classifierRuns: CiClassifierRun[]
}> {
  const reviewers = input.repository.agents.reviewers
  const classifierRuns: CiClassifierRun[] = []
  const names = new Set(input.checks.map((item) => item.check.name))
  const checks = input.checks.map((item) => ({
    evidence: item.evidence,
    link: item.check.link,
    name: item.check.name,
    state: item.check.state,
    workflow: item.check.workflow,
  }))
  const prompt = input.afterEdit
    ? await composeCiClassificationAfterEditPrompt({
        ...input.afterEdit,
        checks,
        directory: input.directory,
        pr: input.pr,
        repository: input.repository,
      })
    : await composeCiClassificationPrompt({
        checks,
        directory: input.directory,
        pr: input.pr,
        repository: input.repository,
      })

  if (!reviewers.length) {
    return {
      classified: input.checks.map((item) => ({
        check: item.check,
        classification: "SCOPE_IN",
        reason: "No reviewer model is configured for CI classification.",
      })),
      classifierRuns,
    }
  }

  if (input.outputDir) await mkdir(input.outputDir, { recursive: true })

  const votes = await mapPool(
    reviewers,
    input.repository.concurrency.reviewers,
    async (reviewer) => {
      const run: CiClassifierRun = {
        repairAttempts: 0,
        reviewer: reviewer.key,
        status: "running",
      }
      const promptPath = input.outputDir
        ? join(input.outputDir, `${reviewer.key}.ci-classification.prompt.txt`)
        : undefined

      run.promptPath = promptPath
      classifierRuns.push(run)
      if (promptPath) await writeFile(promptPath, prompt)
      await input.onClassifierProgress?.({
        promptPath,
        reviewer: reviewer.key,
        type: "classifier_started",
      })

      try {
        const result = await runModelWithRepair({
          client: input.client,
          model: reviewer.model,
          onProgress: async (progress) => {
            if (progress.type === "session_created") {
              run.sessionId = progress.sessionId
              await input.onClassifierProgress?.({
                reviewer: reviewer.key,
                runAttempt: progress.runAttempt,
                sessionId: progress.sessionId,
                type: "classifier_session",
              })
            }
            if (progress.type === "repair") {
              run.status = "repairing"
              run.repairAttempts += 1
              await input.onClassifierProgress?.({
                reviewer: reviewer.key,
                type: "classifier_repair",
              })
            }
          },
          options: reviewer.options,
          parse: (text) => {
            const output = parseCiClassificationOutput(text)

            for (const check of output.checks) {
              if (!names.has(check.name))
                throw new Error(
                  `unexpected CI check classification: ${check.name}`,
                )
            }

            for (const name of names) {
              if (!output.checks.some((check) => check.name === name))
                throw new Error(`missing CI check classification: ${name}`)
            }

            return output
          },
          permission: reviewer.permission,
          prompt,
          repairAttempts: input.repairAttempts,
          runAttempts: 2,
          schemaName: "CI classification",
          signal: input.signal,
          title: `magi classify ci ${input.repository.alias}#${input.pr} ${reviewer.key}`,
        })
        const rawPath = input.outputDir
          ? join(input.outputDir, `${reviewer.key}.ci-classification.raw.txt`)
          : undefined
        const check = result.value.checks[0]

        if (rawPath) await writeFile(rawPath, result.raw)
        run.classification = check?.classification
        run.rawPath = rawPath
        run.reason = check?.reason
        run.sessionId = result.sessionId
        run.status = "completed"
        await input.onClassifierProgress?.({
          classification: check?.classification ?? "SCOPE_IN",
          rawPath,
          reason: check?.reason ?? "No classification reason was provided.",
          reviewer: reviewer.key,
          sessionId: result.sessionId,
          type: "classifier_completed",
        })

        return { reviewer: reviewer.key, output: result.value }
      } catch (error) {
        run.error = errorMessage(error)
        run.status = "failed"
        await input.onClassifierProgress?.({
          error: run.error,
          reviewer: reviewer.key,
          type: "classifier_failed",
        })

        return { reviewer: reviewer.key, output: undefined }
      }
    },
    { signal: input.signal },
  )
  const threshold = majorityThreshold(reviewers.length)

  return {
    classified: input.checks.map((item) => {
      const successfulVotes = votes.filter((vote) => vote.output)
      const checkVotes = successfulVotes.map((vote) => {
        const check = vote.output?.checks.find(
          (output) => output.name === item.check.name,
        )

        return {
          classification: check?.classification ?? "SCOPE_IN",
          reason:
            check?.reason ?? "Missing classification; treated as scope-in.",
          reviewer: vote.reviewer,
        }
      })
      const failures = votes.filter((vote) => !vote.output)
      const scopeIn = checkVotes.filter(
        (vote) => vote.classification === "SCOPE_IN",
      )
      const scopeOut = checkVotes.filter(
        (vote) => vote.classification === "SCOPE_OUT",
      )
      const classification =
        scopeOut.length >= threshold
          ? "SCOPE_OUT"
          : scopeIn.length >= threshold
            ? "SCOPE_IN"
            : undefined

      if (!classification) {
        throw new Error(
          `CI classification did not reach majority for ${item.check.name}`,
        )
      }
      const reasons = checkVotes
        .filter((vote) => vote.classification === classification)
        .map((vote) => `${vote.reviewer}: ${vote.reason}`)
      for (const failure of failures) {
        reasons.push(`${failure.reviewer}: classifier failed; vote ignored`)
      }

      return {
        check: item.check,
        classification,
        reason: reasons.join("; ") || "No majority reason was provided.",
      }
    }),
    classifierRuns,
  }
}

export async function waitForChecksWithClassification(input: {
  afterEdit?: {
    cycle: number
    headSha: string
    previousHeadSha: string
    worktreePath: string
  }
  client: ModelClient
  directory: string
  exec: Exec
  headSha?: string
  onProgress?: (phase: string) => void | Promise<void>
  onClassifierProgress?: (
    progress: CiClassifierProgress,
  ) => void | Promise<void>
  outputDir?: string
  pr: number
  repairAttempts: number
  repository: ResolvedRepository
  dryRun?: boolean
  signal?: AbortSignal
  wait: boolean
  waitPollIntervalMs?: number
  waitPollLimit?: number
}): Promise<CheckWaitResult | undefined> {
  const report = emptyReport()
  let investigated = false
  const runHeadCache = new Map<string, Promise<string | undefined>>()

  async function readTargetChecks(): Promise<TargetChecks> {
    return checksForHead({
      exec: input.exec,
      headSha: input.headSha,
      pr: input.pr,
      repository: input.repository,
      runHeadCache,
    })
  }

  async function assignBlockingChecks(checks: PullRequestCheck[]) {
    report.failed = applyCheckExclusions({
      checks,
      excluded: report.excluded,
      patterns: input.repository.checks.exclude,
    })
  }

  if (input.wait) {
    await input.onProgress?.("waiting for CI checks")

    for (let attempt = 0; ; attempt += 1) {
      try {
        await watchChecks(input.exec, input.repository, input.pr)
      } catch {
        // gh exits non-zero for pending checks too; re-read check state below.
      }

      const target = await readTargetChecks()
      const waitingForTargetHead =
        Boolean(input.headSha) &&
        (!target.hasAnyCheck ||
          (target.hasAnyActionCheck && !target.hasTargetActionCheck))

      if (!waitingForTargetHead && !target.hasPending) {
        await assignBlockingChecks(target.blocking)
        break
      }

      if (attempt >= (input.waitPollLimit ?? 60)) {
        await assignBlockingChecks(target.blocking)
        break
      }

      await sleep(input.waitPollIntervalMs ?? 1_000)
    }
  } else {
    await assignBlockingChecks((await readTargetChecks()).blocking)
  }

  if (report.failed.length && !investigated) {
    await input.onProgress?.("investigating failed CI checks")
  }

  if (!report.failed.length && input.wait && !investigated) {
    await input.onProgress?.("CI checks passed")
  }

  for (;;) {
    if (!report.failed.length) return { ciFailureContext: "", report }

    const cancelled = report.failed.filter(isCancelledCheck)
    const failed = report.failed.filter((check) => !isCancelledCheck(check))
    const scopeOut = cancelled.map(cancelledClassification)
    let scopeIn: ClassifiedCheck[] = []
    let withLogs: CheckWithLog[] = []

    if (failed.length) {
      await input.onProgress?.("fetching failed CI logs")
      withLogs = await checksWithLogs(input.exec, input.repository, failed)
      await input.onProgress?.("classifying CI failures")
      const classifiedResult = await classifyChecks({
        afterEdit: input.afterEdit,
        checks: withLogs,
        client: input.client,
        directory: input.directory,
        onClassifierProgress: input.onClassifierProgress,
        outputDir: input.outputDir,
        pr: input.pr,
        repairAttempts: input.repairAttempts,
        repository: input.repository,
        signal: input.signal,
      })
      const classified = classifiedResult.classified

      report.classifierRuns?.push(...classifiedResult.classifierRuns)
      scopeIn = classified.filter((item) => item.classification === "SCOPE_IN")
      scopeOut.push(
        ...classified.filter((item) => item.classification === "SCOPE_OUT"),
      )
    }

    if (scopeIn.length) {
      await input.onProgress?.("CI failures classified as scope-in")
      report.scopeInside.push(...scopeIn)
      report.scopeOutsideUnresolved.push(...scopeOut)

      return {
        ciFailureContext: ciFailureContextForClassified(withLogs, scopeIn),
        report,
      }
    }

    const rerunnable = scopeOut.filter((item) => checkJobId(item.check))
    const notRerunnable = scopeOut.filter((item) => !checkJobId(item.check))

    if (
      notRerunnable.length ||
      report.attempts >= input.repository.checks.retryFailedJobs
    ) {
      await input.onProgress?.("scope-out CI failures remain unresolved")
      report.scopeOutsideUnresolved.push(...scopeOut)
      return { ciFailureContext: "", report }
    }

    if (input.dryRun) {
      report.dryRunRerun?.push(...rerunnable)
      report.scopeOutsideUnresolved.push(...scopeOut)
      await input.onProgress?.("dry-run skipping scope-out CI reruns")
      return { ciFailureContext: "", report }
    }

    report.attempts += 1
    report.rerun.push(...rerunnable)
    await input.onProgress?.("rerunning scope-out CI jobs")
    await Promise.all(
      rerunnable.map((item) =>
        rerunCheckJob(
          input.exec,
          input.repository,
          checkJobId(item.check) ?? "",
        ),
      ),
    )

    try {
      await input.onProgress?.("waiting for rerun CI checks")
      await watchRerunRuns(input.exec, input.repository, rerunnable)
      if (input.wait) await watchChecks(input.exec, input.repository, input.pr)
    } catch {
      // Re-read the PR checks below so stale failed checks are not trusted.
    }

    report.failed = applyCheckExclusions({
      checks: (await readTargetChecks()).blocking,
      excluded: report.excluded,
      patterns: input.repository.checks.exclude,
    })

    if (!report.failed.length) {
      await input.onProgress?.("rerun CI checks passed")
      report.scopeOutsideRecovered.push(...rerunnable)
      return { ciFailureContext: "", report }
    }

    if (report.failed.length) {
      await input.onProgress?.("investigating failed CI checks")
    }
  }
}
