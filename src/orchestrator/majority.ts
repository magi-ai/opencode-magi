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

export interface StringVote<T extends string> {
  reviewer: string
  vote: T
}

export interface StringMajorityResult<T extends string> {
  counts: Record<T, number>
  threshold: number
  vote?: T
  voters: Record<T, string[]>
}

export type ApprovalPolicy = "majority" | "unanimous"

const VERDICTS: Verdict[] = ["MERGE", "CHANGES_REQUESTED", "CLOSE"]

export function majorityThreshold(total: number): number {
  return Math.floor(total / 2) + 1
}

export function aggregateStringMajority<T extends string>(
  results: StringVote<T>[],
  votes: readonly T[],
): StringMajorityResult<T> {
  if (results.length < 3 || results.length % 2 === 0) {
    throw new Error("majority requires an odd number of at least 3 results")
  }

  const counts = Object.fromEntries(votes.map((vote) => [vote, 0])) as Record<
    T,
    number
  >
  const voters = Object.fromEntries(
    votes.map((vote) => [vote, []]),
  ) as unknown as Record<T, string[]>

  for (const result of results) {
    counts[result.vote] += 1
    voters[result.vote].push(result.reviewer)
  }

  const threshold = majorityThreshold(results.length)
  const vote = votes.find((item) => counts[item] >= threshold)

  return { counts, threshold, vote, voters }
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
