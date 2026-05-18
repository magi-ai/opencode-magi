import type { CheckWaitReport } from "../github/commands"
import type {
  EditOutput,
  Finding,
  ResolvedRepository,
  RereviewOutput,
  ReviewOutput,
} from "../types"
import type { FindingValidationTarget } from "./findings"
import type { SafetyGateResult } from "./safety"
import { formatSafetyGateReport } from "./safety"

type ReviewerOutput = RereviewOutput | ReviewOutput
type MergeStatus =
  | "changes_unresolved"
  | "ci_unresolved"
  | "approved"
  | "close_requested"
  | "closed"
  | "dequeued"
  | "merged"
  | "safety_blocked"

export interface ReviewReportInput {
  ciReports: CheckWaitReport[]
  discardedFindings?: FindingValidationTarget[]
  dryRun?: boolean
  outputs: Record<string, ReviewerOutput>
  posted: Record<string, string>
  repository: ResolvedRepository
  safety?: SafetyGateResult
}

export interface MergeReportInput extends ReviewReportInput {
  editorOutputs?: EditOutput[]
  status: MergeStatus
}

function reportUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim()

  if (!trimmed || trimmed.startsWith("skipped:")) return undefined
  if (!/^https?:\/\//.test(trimmed)) return undefined

  return trimmed
}

function linkOrText(text: string, url: string | undefined): string {
  return url ? `[${text}](${url})` : text
}

function formatFinding(finding: Finding): string {
  const line =
    finding.startLine == null
      ? `${finding.path}:${finding.line}`
      : `${finding.path}:${finding.startLine}-${finding.line}`

  return `\`${line}\`: ${finding.issue}`
}

function formatRereviewFinding(
  finding: RereviewOutput["newFindings"][number],
): string {
  const line =
    finding.startLine == null
      ? `${finding.path}:${finding.line}`
      : `${finding.path}:${finding.startLine}-${finding.line}`

  return `\`${line}\`: ${finding.body}`
}

function isReviewOutput(output: ReviewerOutput): output is ReviewOutput {
  return "findings" in output
}

function discardedByReviewer(
  discarded: FindingValidationTarget[] | undefined,
): Record<string, Finding[]> {
  const grouped: Record<string, Finding[]> = {}

  for (const item of discarded ?? []) {
    grouped[item.reviewer] = [...(grouped[item.reviewer] ?? []), item.finding]
  }

  return grouped
}

function checkLines(reports: CheckWaitReport[]): string[] {
  const failures = reports.flatMap((report) => [
    ...report.scopeInside.map((item) => ({
      name: item.check.name,
      reason: item.reason,
    })),
    ...report.scopeOutsideUnresolved.map((item) => ({
      name: item.check.name,
      reason: item.reason,
    })),
    ...(report.dryRunRerun ?? []).map((item) => ({
      name: item.check.name,
      reason: `Dry run would rerun scope-out job: ${item.reason}`,
    })),
  ])

  if (!failures.length) return ["- **Check**: Pass"]

  return [
    "- **Check**: Failure",
    ...failures.map((failure) => `  - **${failure.name}**: ${failure.reason}`),
  ]
}

function dryRunLines(dryRun: boolean | undefined): string[] {
  return dryRun ? ["- **Dry run**: GitHub write operations were skipped"] : []
}

function safetyLines(safety: SafetyGateResult | undefined): string[] {
  return safety ? formatSafetyGateReport(safety).split("\n") : []
}

function reviewerStatus(
  output: ReviewerOutput,
  url: string | undefined,
): string {
  if (output.verdict === "MERGE") return "Approved"
  if (output.verdict === "CLOSE") return linkOrText("Closed", url)

  return linkOrText("Changes requested", url)
}

function reviewerDetailLines(output: ReviewerOutput): string[] {
  if (isReviewOutput(output)) {
    if (output.verdict === "CLOSE") return output.reason ? [output.reason] : []
    if (output.verdict !== "CHANGES_REQUESTED") return []

    return output.findings.map(formatFinding)
  }

  if (output.verdict === "CLOSE") return output.reason ? [output.reason] : []
  if (output.verdict !== "CHANGES_REQUESTED") return []

  return [
    ...output.newFindings.map(formatRereviewFinding),
    ...output.followUps.map(
      (item) => `Comment #${item.commentId}: ${item.body}`,
    ),
  ]
}

function reviewerLines(input: ReviewReportInput): string[] {
  const discarded = discardedByReviewer(input.discardedFindings)
  const lines = ["- **Reviewer**:"]

  for (const reviewer of input.repository.agents.reviewers) {
    const output = input.outputs[reviewer.key]
    const url = reportUrl(input.posted[reviewer.key])

    if (!output) {
      lines.push(`  - **${reviewer.key}**: Skipped`)
      continue
    }

    lines.push(`  - **${reviewer.key}**: ${reviewerStatus(output, url)}`)

    for (const detail of reviewerDetailLines(output)) {
      lines.push(`    - ${detail}`)
    }
    for (const finding of discarded[reviewer.key] ?? []) {
      lines.push(`    - ~~${formatFinding(finding)}~~`)
    }
  }

  return lines
}

function mergeStatusLines(status: MergeStatus): string[] {
  switch (status) {
    case "merged":
      return ["- **Status**: Merged"]
    case "closed":
      return ["- **Status**: Closed"]
    case "approved":
      return ["- **Status**: Approved"]
    case "close_requested":
      return ["- **Status**: Close requested"]
    case "dequeued":
      return ["- **Status**: Failed", "  - Removed from GitHub merge queue."]
    case "ci_unresolved":
      return ["- **Status**: Failed", "  - CI remained unresolved."]
    case "safety_blocked":
      return ["- **Status**: Safety blocked"]
    case "changes_unresolved":
      return [
        "- **Status**: Failed",
        "  - Changes remained unresolved after the per-thread resolution attempt limit.",
      ]
  }
}

function editorLines(outputs: EditOutput[] | undefined): string[] {
  if (!outputs?.length) return []

  return [
    "- **Editor**:",
    ...outputs.flatMap((output, index) => {
      const label = `  - Cycle ${index + 1}`

      if (output.mode === "REPLIED") {
        return [
          `${label}: replied without code changes`,
          ...output.responses.map(
            (response) =>
              `    - ${response.action} comment #${response.commentId}: ${response.body}`,
          ),
        ]
      }

      return [
        `${label}: ${output.commitMessage} (${output.commitSha?.slice(0, 7)})`,
        ...output.filesTouched.map((file) => `    - ${file}`),
        ...output.responses.map(
          (response) =>
            `    - ${response.action} comment #${response.commentId}: ${response.body}`,
        ),
      ]
    }),
  ]
}

export function formatReviewReport(input: ReviewReportInput): string {
  return [
    ...dryRunLines(input.dryRun),
    ...safetyLines(input.safety),
    ...checkLines(input.ciReports),
    ...reviewerLines(input),
  ].join("\n")
}

export function formatMergeReport(input: MergeReportInput): string {
  return [
    ...mergeStatusLines(input.status),
    ...dryRunLines(input.dryRun),
    ...safetyLines(input.safety),
    ...checkLines(input.ciReports),
    ...reviewerLines(input),
    ...editorLines(input.editorOutputs),
  ].join("\n")
}
