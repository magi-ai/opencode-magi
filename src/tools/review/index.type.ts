import type { Octokit } from "octokit"
import type {
  ClosingIssuesQuery,
  ExpectNode,
  ReviewThreadsQuery,
} from "@/graphql"

export type PullRequestVerdict = "APPROVED" | "CHANGES_REQUESTED" | "CLOSED"

export interface PullRequestCheck {
  bucket: string
  classifieds?: PullRequestClassifiedChecks
  id: string
  link: string
  log?: string
  name: string
  scope?: boolean
  state: string
  workflow: string
}

export interface PullRequestChecks {
  excluded: PullRequestCheck[]
  failed: PullRequestCheck[]
  passed: PullRequestCheck[]
  pending: PullRequestCheck[]
}

export interface PullRequestClassifiedChecks {
  [key: string]: { comment: string; scope: boolean }
}

export type PullRequestAutomationResult =
  | "closed"
  | "dequeued"
  | "queued"
  | "skipped"
  | "submitted"

export interface PullRequestFinding {
  body: string
  line: number
  path: string
  startLine?: number
  state: "accepted" | "discarded" | "resolved"
}

export interface PullRequestFollowUp {
  body: string
  commentId: number
}

export interface PullRequestResolveThread {
  commentId: number
  threadId: string
}

export interface CiClassificationOutput {
  checks: {
    classification: "SCOPE_IN" | "SCOPE_OUT"
    comment: string
    id: string
  }[]
}

export interface ReviewOutput {
  comment?: string
  findings?: PullRequestFinding[]
  followUps?: PullRequestFollowUp[]
  newFindings?: PullRequestFinding[]
  resolves?: PullRequestResolveThread[]
  verdict: PullRequestVerdict
}

export interface FindingValidationOutput {
  votes: {
    comment: string
    index: number
    reviewer: string
    vote: "AGREE" | "DISAGREE"
  }[]
}

export type PullRequestMetadata = Awaited<
  ReturnType<Octokit["rest"]["pulls"]["get"]>
>["data"]

export type PullRequestReview = Awaited<
  ReturnType<Octokit["rest"]["pulls"]["listReviews"]>
>["data"][number]

export type PullRequestCommit = Awaited<
  ReturnType<Octokit["rest"]["pulls"]["listCommits"]>
>["data"][number]

export type PullRequestComment = Awaited<
  ReturnType<Octokit["rest"]["issues"]["listComments"]>
>["data"][number]

export type PullRequestReviewParams = Parameters<
  Octokit["rest"]["pulls"]["createReview"]
>[0]

export interface PullRequestClosingIssue extends Omit<
  ExpectNode<ClosingIssuesQuery>,
  "comments"
> {
  comments: ExpectNode<ExpectNode<ClosingIssuesQuery>["comments"]>[]
}

export interface PullRequestReviewThread extends Omit<
  ExpectNode<ReviewThreadsQuery>,
  "comments"
> {
  comments: ExpectNode<ExpectNode<ReviewThreadsQuery>["comments"]>[]
}

export interface PullRequestInlineCommentTargets {
  [key: string]: { [key: string]: number[] }
}

export interface PullRequestReviewMarker {
  body?: string
  command?: string
  reviewer?: string
  verdict?: PullRequestVerdict
}
