import type { ReviewOutput, Verdict } from "../types"

export interface ReviewerVerdict {
  reviewer: string
  verdict: Verdict
}

export interface MajorityResult {
  counts: Record<Verdict, number>
  reviewers: Record<Verdict, string[]>
  threshold: number
  verdict: Verdict
}

export type ApprovalPolicy = "majority" | "unanimous"

const VERDICTS: Verdict[] = ["MERGE", "CHANGES_REQUESTED", "CLOSE"]

export function majorityThreshold(total: number): number {
  return Math.floor(total / 2) + 1
}

export function aggregateMajority(results: ReviewerVerdict[]): MajorityResult {
  if (results.length < 3 || results.length % 2 === 0) {
    throw new Error(
      "majority requires an odd number of at least 3 reviewer results",
    )
  }

  const counts: Record<Verdict, number> = {
    CHANGES_REQUESTED: 0,
    CLOSE: 0,
    MERGE: 0,
  }
  const reviewers: Record<Verdict, string[]> = {
    CHANGES_REQUESTED: [],
    CLOSE: [],
    MERGE: [],
  }

  for (const result of results) {
    counts[result.verdict] += 1
    reviewers[result.verdict].push(result.reviewer)
  }

  const threshold = majorityThreshold(results.length)
  const verdict = VERDICTS.find((item) => counts[item] >= threshold)

  if (!verdict) throw new Error("no majority verdict")

  return { counts, reviewers, threshold, verdict }
}

export function reviewOutputsToVerdicts(
  outputs: Record<string, ReviewOutput>,
): ReviewerVerdict[] {
  return Object.entries(outputs).map(([reviewer, output]) => ({
    reviewer,
    verdict: output.verdict,
  }))
}

export function mergeVerdictForPolicy(
  results: ReviewerVerdict[],
  policy: ApprovalPolicy,
): Verdict {
  const majority = aggregateMajority(results)

  if (majority.verdict === "CLOSE") return "CLOSE"
  if (policy === "majority") return majority.verdict

  return majority.counts.MERGE === results.length
    ? "MERGE"
    : "CHANGES_REQUESTED"
}

export function closeMinorityReviewers(results: ReviewerVerdict[]): string[] {
  const majority = aggregateMajority(results)

  return majority.verdict === "CLOSE" ? [] : majority.reviewers.CLOSE
}
