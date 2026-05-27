import type { Exec, ResolvedRepository } from "../types"
import {
  fetchIssue,
  fetchIssueCommentPage,
  fetchPullRequestClosingIssues,
  fetchPullRequestCommentPage,
  fetchPullRequestReviewThreadPage,
  fetchPullRequestSafetyMeta,
  type IssueComment,
  type IssueMeta,
  type PullRequestMeta,
  type ReviewThread,
} from "../github/commands"

const LIMITS = {
  closingIssueComments: 20,
  commentBody: 4000,
  prComments: 20,
  referencedIssueComments: 10,
  reviewThreadComments: 20,
  reviewThreads: 50,
} as const

export interface ReviewContextComment {
  author: string
  body: string
  createdAt: string
  id: number
  truncated?: boolean
  url?: string
}

export interface ReviewContextIssue {
  author: string
  body: string
  comments: ReviewContextComment[]
  commentsOmitted: number
  number: number
  relationship: "closing" | "referenced"
  source: string
  state: string
  title: string
  url: string
}

export interface IssueRelationship {
  number: number
  relationship: "closing" | "referenced"
  sources: string[]
}

export interface ReviewContextSnapshot {
  closingIssues: ReviewContextIssue[]
  pullRequest: {
    author: string
    baseRef: string
    baseSha: string
    body: string
    changedFiles: string[]
    comments: ReviewContextComment[]
    commentsOmitted: number
    headRef: string
    headSha: string
    number: number
    relationship: "target"
    source: string
    state: string
    title: string
    url: string
  }
  referencedIssues: ReviewContextIssue[]
  reviewDiscussion: {
    prComments: ReviewContextComment[]
    prCommentsOmitted: number
    reviewThreads: ReviewThread[]
    reviewThreadsOmitted: number
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function truncateBody(body: string): { body: string; truncated?: boolean } {
  if (body.length <= LIMITS.commentBody) return { body }

  return {
    body: `${body.slice(0, LIMITS.commentBody)}\n[truncated after ${LIMITS.commentBody} characters]`,
    truncated: true,
  }
}

function boundedComments(
  comments: IssueComment[],
  limit: number,
): ReviewContextComment[] {
  return [...comments]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(-limit)
    .map((comment) => ({
      author: comment.author,
      createdAt: comment.createdAt,
      id: comment.id,
      url: comment.url,
      ...truncateBody(comment.body),
    }))
}

function omittedCommentCount(input: {
  comments: IssueComment[]
  limit: number
  omitted: number
}): number {
  return input.omitted + Math.max(0, input.comments.length - input.limit)
}

function quoteEvidence(value: string): string {
  const compact = value.replaceAll(/\s+/g, " ").trim()

  return compact.length > 120 ? `${compact.slice(0, 117)}...` : compact
}

function errorText(error: unknown): string {
  if (!error || typeof error !== "object") return String(error)

  const value = error as {
    message?: unknown
    stderr?: unknown
    stdout?: unknown
  }

  return [value.message, value.stderr, value.stdout]
    .filter((item): item is string => typeof item === "string")
    .join("\n")
}

function isIssueLookupFailure(error: unknown): boolean {
  const text = errorText(error)

  return (
    /could not resolve to an issue/i.test(text) ||
    /could not fetch issue #\d+/i.test(text) ||
    /not an issue/i.test(text)
  )
}

function isIssueUrl(url: string): boolean {
  return /\/issues\/\d+(?:$|[/?#])/i.test(url)
}

function issueReferencePattern(repository: ResolvedRepository): RegExp {
  const host = escapeRegExp(repository.github.host || "github.com")
  const owner = escapeRegExp(repository.github.owner)
  const repo = escapeRegExp(repository.github.repo)

  return new RegExp(
    `(?:https?://${host}/${owner}/${repo}/issues/(\\d+)|#(\\d+))`,
    "gi",
  )
}

function issueNumberFromMatch(match: RegExpMatchArray): number {
  return Number(match[1] ?? match[2])
}

function addRelationship(
  relationships: Map<number, IssueRelationship>,
  number: number,
  relationship: IssueRelationship["relationship"],
  source: string,
): void {
  const current = relationships.get(number)
  const nextRelationship =
    current?.relationship === "closing" || relationship === "closing"
      ? "closing"
      : "referenced"
  const sources = current?.sources ?? []

  relationships.set(number, {
    number,
    relationship: nextRelationship,
    sources: sources.includes(source) ? sources : [...sources, source],
  })
}

function scanRelationshipText(input: {
  currentPr: number
  label: string
  relationships: Map<number, IssueRelationship>
  repository: ResolvedRepository
  text: string
}): void {
  const referencePattern = issueReferencePattern(input.repository)
  const closingPattern = new RegExp(
    `\\b(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\\b[\\s\\S]{0,80}?${referencePattern.source}`,
    "gi",
  )

  for (const match of input.text.matchAll(referencePattern)) {
    const number = issueNumberFromMatch(match)

    if (number === input.currentPr) continue
    addRelationship(
      input.relationships,
      number,
      "referenced",
      `${input.label} "${quoteEvidence(match[0])}"`,
    )
  }

  for (const match of input.text.matchAll(closingPattern)) {
    const number = Number(match[1] ?? match[2])

    if (!number || number === input.currentPr) continue
    addRelationship(
      input.relationships,
      number,
      "closing",
      `${input.label} "${quoteEvidence(match[0])}"`,
    )
  }
}

export function collectIssueRelationships(input: {
  closingIssues: IssueMeta[]
  pr: PullRequestMeta
  prComments: IssueComment[]
  repository: ResolvedRepository
  reviewThreads: ReviewThread[]
}): IssueRelationship[] {
  const relationships = new Map<number, IssueRelationship>()

  for (const issue of input.closingIssues) {
    if (issue.number === input.pr.number) continue
    addRelationship(
      relationships,
      issue.number,
      "closing",
      "GitHub closingIssuesReferences",
    )
  }

  scanRelationshipText({
    currentPr: input.pr.number,
    label: "PR title",
    relationships,
    repository: input.repository,
    text: input.pr.title,
  })
  scanRelationshipText({
    currentPr: input.pr.number,
    label: "PR body",
    relationships,
    repository: input.repository,
    text: input.pr.body ?? "",
  })

  for (const comment of input.prComments) {
    scanRelationshipText({
      currentPr: input.pr.number,
      label: `PR comment ${comment.id}`,
      relationships,
      repository: input.repository,
      text: comment.body,
    })
  }

  for (const thread of input.reviewThreads) {
    for (const comment of thread.comments) {
      scanRelationshipText({
        currentPr: input.pr.number,
        label: `review thread ${thread.threadId} comment ${comment.commentId}`,
        relationships,
        repository: input.repository,
        text: comment.body,
      })
    }
  }

  return [...relationships.values()].sort((a, b) => a.number - b.number)
}

async function contextIssue(input: {
  exec: Exec
  issue?: IssueMeta
  limit: number
  relationship: IssueRelationship
  repository: ResolvedRepository
}): Promise<ReviewContextIssue> {
  const issue =
    input.issue ??
    (await fetchIssue(input.exec, input.repository, input.relationship.number))

  if (!isIssueUrl(issue.url)) {
    throw new Error(
      `Reference #${issue.number} resolved to ${issue.url}, not an Issue`,
    )
  }

  const commentPage = await fetchIssueCommentPage(
    input.exec,
    input.repository,
    issue.number,
    input.limit,
  )

  return {
    author: issue.author,
    body: issue.body,
    comments: boundedComments(commentPage.comments, input.limit),
    commentsOmitted: omittedCommentCount({
      comments: commentPage.comments,
      limit: input.limit,
      omitted: commentPage.omitted,
    }),
    number: issue.number,
    relationship: input.relationship.relationship,
    source: input.relationship.sources.join("; "),
    state: issue.state,
    title: issue.title,
    url: issue.url,
  }
}

async function contextIssueIfIssue(input: {
  exec: Exec
  issue?: IssueMeta
  limit: number
  relationship: IssueRelationship
  repository: ResolvedRepository
}): Promise<ReviewContextIssue | undefined> {
  try {
    return await contextIssue(input)
  } catch (error) {
    if (isIssueLookupFailure(error)) return undefined

    throw error
  }
}

function presentIssue(
  issue: ReviewContextIssue | undefined,
): issue is ReviewContextIssue {
  return Boolean(issue)
}

function orderReviewThreads(threads: ReviewThread[]): ReviewThread[] {
  return [...threads]
    .sort((a, b) => {
      if (a.isResolved !== b.isResolved) return a.isResolved ? 1 : -1

      const aLatest = a.comments.at(-1)?.createdAt ?? ""
      const bLatest = b.comments.at(-1)?.createdAt ?? ""

      return bLatest.localeCompare(aLatest)
    })
    .slice(0, LIMITS.reviewThreads)
    .map((thread) => ({
      ...thread,
      comments: thread.comments
        .slice(-LIMITS.reviewThreadComments)
        .map((comment) => ({
          ...comment,
          ...truncateBody(comment.body),
        })),
    }))
}

export async function buildReviewContextSnapshot(input: {
  exec: Exec
  pr: PullRequestMeta
  repository: ResolvedRepository
}): Promise<ReviewContextSnapshot> {
  const [prCommentPage, reviewThreadPage, safetyMeta, closingIssues] =
    await Promise.all([
      fetchPullRequestCommentPage(
        input.exec,
        input.repository,
        input.pr.number,
        LIMITS.prComments,
      ),
      fetchPullRequestReviewThreadPage(
        input.exec,
        input.repository,
        input.pr.number,
        LIMITS.reviewThreads,
        LIMITS.reviewThreadComments,
      ),
      fetchPullRequestSafetyMeta(input.exec, input.repository, input.pr.number),
      fetchPullRequestClosingIssues(
        input.exec,
        input.repository,
        input.pr.number,
      ).catch(() => []),
    ])
  const prComments = prCommentPage.comments
  const orderedReviewThreads = orderReviewThreads(reviewThreadPage.threads)
  const prCommentsOmitted = omittedCommentCount({
    comments: prComments,
    limit: LIMITS.prComments,
    omitted: prCommentPage.omitted,
  })
  const relationships = collectIssueRelationships({
    closingIssues,
    pr: input.pr,
    prComments,
    repository: input.repository,
    reviewThreads: orderedReviewThreads,
  })
  const closingIssueMap = new Map(
    closingIssues.map((issue) => [issue.number, issue]),
  )
  const closingRelationships = relationships.filter(
    (relationship) => relationship.relationship === "closing",
  )
  const referencedRelationships = relationships.filter(
    (relationship) => relationship.relationship === "referenced",
  )

  return {
    closingIssues: (
      await Promise.all(
        closingRelationships.map((relationship) =>
          contextIssueIfIssue({
            exec: input.exec,
            issue: closingIssueMap.get(relationship.number),
            limit: LIMITS.closingIssueComments,
            relationship,
            repository: input.repository,
          }),
        ),
      )
    ).filter(presentIssue),
    pullRequest: {
      author: input.pr.author?.login ?? safetyMeta.author,
      baseRef: input.pr.baseRefName,
      baseSha: input.pr.baseRefOid,
      body: input.pr.body ?? "",
      changedFiles: safetyMeta.files,
      comments: boundedComments(prComments, LIMITS.prComments),
      commentsOmitted: prCommentsOmitted,
      headRef: input.pr.headRefName,
      headSha: input.pr.headRefOid,
      number: input.pr.number,
      relationship: "target",
      source: "/magi:review input",
      state: input.pr.state ?? "",
      title: input.pr.title,
      url: input.pr.url,
    },
    referencedIssues: (
      await Promise.all(
        referencedRelationships.map((relationship) =>
          contextIssueIfIssue({
            exec: input.exec,
            limit: LIMITS.referencedIssueComments,
            relationship,
            repository: input.repository,
          }),
        ),
      )
    ).filter(presentIssue),
    reviewDiscussion: {
      prComments: boundedComments(prComments, LIMITS.prComments),
      prCommentsOmitted,
      reviewThreads: orderedReviewThreads,
      reviewThreadsOmitted: reviewThreadPage.omitted,
    },
  }
}

function indented(value: string): string {
  return value.trim() ? value : "(empty)"
}

function renderOmissionNote(
  omitted: number,
  label: string,
  limit: number,
): string {
  return omitted > 0
    ? `\n[omitted ${omitted} older ${label} due to limit ${limit}]`
    : ""
}

function renderComments(
  comments: ReviewContextComment[],
  omitted = 0,
  limit = comments.length,
): string {
  if (!comments.length)
    return `(none)${renderOmissionNote(omitted, "comments", limit)}`

  return (
    comments
      .map((comment) => {
        const suffix = comment.truncated ? " [truncated]" : ""

        return `- ${comment.createdAt} @${comment.author} (${comment.id})${suffix}\n${indented(comment.body)}`
      })
      .join("\n") + renderOmissionNote(omitted, "comments", limit)
  )
}

function renderIssue(issue: ReviewContextIssue): string {
  return `<issue>
number: ${issue.number}
title: ${issue.title}
url: ${issue.url}
state: ${issue.state}
author: ${issue.author}
relationship: ${issue.relationship}
source: ${issue.source}
body:
${indented(issue.body)}
comments:
${renderComments(issue.comments, issue.commentsOmitted, issue.relationship === "closing" ? LIMITS.closingIssueComments : LIMITS.referencedIssueComments)}
</issue>`
}

function renderThreads(threads: ReviewThread[], omitted = 0): string {
  if (!threads.length) {
    return `(none)${renderOmissionNote(omitted, "review threads", LIMITS.reviewThreads)}`
  }

  return (
    threads
      .map((thread) => {
        const comments =
          thread.comments
            .map((comment) => {
              const suffix = comment.truncated ? " [truncated]" : ""

              return `  - ${comment.createdAt} @${comment.author} (${comment.commentId})${suffix}\n${indented(comment.body)}`
            })
            .join("\n") +
          renderOmissionNote(
            thread.omittedComments ?? 0,
            "thread comments",
            LIMITS.reviewThreadComments,
          )

        return `- threadId: ${thread.threadId}\n  resolved: ${Boolean(thread.isResolved)}\n  path: ${thread.path}:${thread.line}\n  comments:\n${comments}`
      })
      .join("\n") +
    renderOmissionNote(omitted, "review threads", LIMITS.reviewThreads)
  )
}

export function renderReviewContext(snapshot: ReviewContextSnapshot): string {
  return [
    `<pull_request_context>
number: ${snapshot.pullRequest.number}
title: ${snapshot.pullRequest.title}
url: ${snapshot.pullRequest.url}
state: ${snapshot.pullRequest.state}
author: ${snapshot.pullRequest.author}
relationship: ${snapshot.pullRequest.relationship}
source: ${snapshot.pullRequest.source}
baseRef: ${snapshot.pullRequest.baseRef}
headRef: ${snapshot.pullRequest.headRef}
baseSha: ${snapshot.pullRequest.baseSha}
headSha: ${snapshot.pullRequest.headSha}
body:
${indented(snapshot.pullRequest.body)}
comments:
${renderComments(snapshot.pullRequest.comments, snapshot.pullRequest.commentsOmitted, LIMITS.prComments)}
changedFiles:
${snapshot.pullRequest.changedFiles.length ? snapshot.pullRequest.changedFiles.map((file) => `- ${file}`).join("\n") : "(none)"}
</pull_request_context>`,
    `<closing_issues>
${snapshot.closingIssues.length ? snapshot.closingIssues.map(renderIssue).join("\n") : "(none)"}
</closing_issues>`,
    `<referenced_issues>
${snapshot.referencedIssues.length ? snapshot.referencedIssues.map(renderIssue).join("\n") : "(none)"}
</referenced_issues>`,
    `<review_discussion>
prComments:
${renderComments(snapshot.reviewDiscussion.prComments, snapshot.reviewDiscussion.prCommentsOmitted, LIMITS.prComments)}
reviewThreads:
${renderThreads(snapshot.reviewDiscussion.reviewThreads, snapshot.reviewDiscussion.reviewThreadsOmitted)}
</review_discussion>`,
  ].join("\n\n")
}
