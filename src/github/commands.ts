import type { Exec, Finding, ResolvedRepository } from "../types"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

export interface PullRequestMeta {
  author?: { login?: string }
  baseRefName: string
  baseRefOid: string
  body?: string
  changedFiles?: number
  headRepository?: { name?: string }
  headRepositoryOwner?: { login?: string }
  headRefName: string
  headRefOid: string
  isDraft: boolean
  number: number
  state?: string
  title: string
  url: string
}

export interface PullRequestSafetyMeta {
  author: string
  changedFiles: number
  files: string[]
  labels: string[]
}

export interface PullRequestMergeStatus {
  autoMergeRequest?: unknown
  mergeStateStatus?: string
  state: string
}

export interface PullRequestQueueStatus {
  isInMergeQueue: boolean
  mergeQueueEntry?: unknown
  state: string
}

export interface WorkflowRunMeta {
  conclusion?: string
  headSha: string
  status: string
}

export interface ReviewThread {
  body?: string
  commentId: number
  comments: ReviewThreadComment[]
  isResolved?: boolean
  latestBody?: string
  line: number
  omittedComments?: number
  path: string
  threadId: string
}

export interface ReviewThreadComment {
  author: string
  body: string
  commentId: number
  createdAt: string
  truncated?: boolean
}

export interface PullRequestReview {
  author: { login: string }
  body?: string
  comments?: PullRequestReviewComment[]
  commit?: { oid: string }
  state: string
  submittedAt: string
}

export interface PullRequestReviewComment {
  body: string
  line?: number | null
  path: string
  startLine?: number | null
}

export interface PullRequestCommit {
  committedDate: string
  oid: string
  parentCount: number
}

export interface PullRequestCheck {
  bucket: string
  link: string
  name: string
  state: string
  workflow: string
}

export interface FetchPullRequestChecksOptions {
  tolerateMissingChecks?: boolean
}

export interface IssueComment {
  author: string
  authorAssociation?: string
  body: string
  createdAt: string
  id: number
  url: string
}

export interface IssueCommentPage {
  comments: IssueComment[]
  omitted: number
}

export interface PullRequestReviewThreadPage {
  omitted: number
  threads: ReviewThread[]
}

export interface PostedIssueComment {
  id: number
  url: string
}

export interface IssueMeta {
  author: string
  body: string
  labels: string[]
  number: number
  state: string
  title: string
  type?: string
  url: string
}

export interface RelatedPullRequest {
  author: string
  body?: string
  mergedAt?: string
  number: number
  state: "CLOSED" | "MERGED" | "OPEN"
  title: string
  url: string
}

function normalizeRelatedPullRequestState(
  state?: string,
): RelatedPullRequest["state"] {
  const normalized = state?.toUpperCase()

  if (normalized === "MERGED") return "MERGED"
  if (normalized === "CLOSED") return "CLOSED"

  return "OPEN"
}

export interface DuplicateIssueCandidate {
  body?: string
  createdAt?: string
  number: number
  state: string
  title: string
  url: string
  whyCandidate: string
}

export interface ClassifiedCheck {
  check: PullRequestCheck
  classification: "SCOPE_IN" | "SCOPE_OUT"
  reason: string
}

export interface CiClassifierRun {
  classification?: "SCOPE_IN" | "SCOPE_OUT"
  error?: string
  promptPath?: string
  rawPath?: string
  reason?: string
  repairAttempts: number
  reviewer: string
  sessionId?: string
  status: "completed" | "failed" | "repairing" | "running"
}

export interface CheckWaitReport {
  attempts: number
  classifierRuns?: CiClassifierRun[]
  dryRunRerun?: ClassifiedCheck[]
  excluded: PullRequestCheck[]
  failed: PullRequestCheck[]
  rerun: ClassifiedCheck[]
  scopeInside: ClassifiedCheck[]
  scopeOutsideRecovered: ClassifiedCheck[]
  scopeOutsideUnresolved: ClassifiedCheck[]
}

export interface CreatedWorktree {
  branch?: string
  path: string
}

const WORKTREE_CHECKOUT_RETRY_ATTEMPTS = 5
const WORKTREE_CHECKOUT_RETRY_DELAY_MS = 100
const worktreeCreateLocks = new Map<string, Promise<void>>()

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

function isCheckoutConfigLockError(error: unknown): boolean {
  const text = errorText(error)

  return (
    /could not lock config file/i.test(text) ||
    /Unable to write upstream branch configuration/i.test(text)
  )
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms))
}

async function withWorktreeCreateLock<T>(
  key: string,
  run: () => Promise<T>,
): Promise<T> {
  const previous = worktreeCreateLocks.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.catch(() => undefined).then(() => current)

  worktreeCreateLocks.set(key, tail)
  await previous.catch(() => undefined)

  try {
    return await run()
  } finally {
    release()
    if (worktreeCreateLocks.get(key) === tail) worktreeCreateLocks.delete(key)
  }
}

async function checkoutPullRequestWithRetry(
  exec: Exec,
  repository: ResolvedRepository,
  pr: number,
  worktreePath: string,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await exec(
        `gh pr checkout ${pr} --repo ${shellQuote(repoSpecifier(repository))} --detach`,
        {
          cwd: worktreePath,
        },
      )
      return
    } catch (error) {
      if (
        attempt >= WORKTREE_CHECKOUT_RETRY_ATTEMPTS - 1 ||
        !isCheckoutConfigLockError(error)
      ) {
        throw error
      }

      await delay(WORKTREE_CHECKOUT_RETRY_DELAY_MS * 2 ** attempt)
    }
  }
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

export function repoSlug(repository: ResolvedRepository): string {
  return `${repository.github.owner}/${repository.github.repo}`
}

function githubHost(repository: ResolvedRepository): string {
  return repository.github.host || "github.com"
}

export function repoSpecifier(repository: ResolvedRepository): string {
  const host = githubHost(repository)

  return host === "github.com"
    ? repoSlug(repository)
    : `${host}/${repoSlug(repository)}`
}

function repositoryGitUrl(
  repository: ResolvedRepository,
  owner: string,
  repo: string,
): string {
  return `https://${githubHost(repository)}/${owner}/${repo}.git`
}

export function ghHostOption(repository: ResolvedRepository): string {
  const host = githubHost(repository)

  return host === "github.com" ? "" : ` --hostname ${shellQuote(host)}`
}

export async function ghToken(
  exec: Exec,
  repository: ResolvedRepository,
  account: string,
): Promise<string> {
  return (
    await exec(
      `gh auth token${ghHostOption(repository)} --user ${shellQuote(account)}`,
    )
  ).trim()
}

function ghTokenEnv(token: string): { env: Record<string, string> } {
  return { env: { GH_TOKEN: token } }
}

async function fetchPullRequestQueueInput(
  exec: Exec,
  repository: ResolvedRepository,
  pr: number,
  token: string,
): Promise<{ headRefOid: string; id: string }> {
  const query = `query($owner: String!, $repo: String!, $pr: Int!) { repository(owner: $owner, name: $repo) { pullRequest(number: $pr) { id headRefOid } } }`
  const raw = await exec(
    `gh api${ghHostOption(repository)} graphql -f query=${shellQuote(query)} -F owner=${shellQuote(repository.github.owner)} -F repo=${shellQuote(repository.github.repo)} -F pr=${pr}`,
    ghTokenEnv(token),
  )
  const data = JSON.parse(raw) as {
    data?: {
      repository?: {
        pullRequest?: { headRefOid?: string; id?: string }
      }
    }
  }
  const pullRequest = data.data?.repository?.pullRequest

  if (!pullRequest?.id || !pullRequest.headRefOid) {
    throw new Error(`Could not fetch pull request queue metadata for #${pr}`)
  }

  return { headRefOid: pullRequest.headRefOid, id: pullRequest.id }
}

export async function fetchPullRequest(
  exec: Exec,
  repository: ResolvedRepository,
  pr: number,
): Promise<PullRequestMeta> {
  const json = await exec(
    `gh pr view ${pr} --repo ${shellQuote(repoSpecifier(repository))} --json number,title,body,url,state,author,isDraft,baseRefOid,headRefOid,baseRefName,headRefName,headRepository,headRepositoryOwner,changedFiles`,
  )

  return JSON.parse(json) as PullRequestMeta
}

export async function fetchPullRequestClosingIssues(
  exec: Exec,
  repository: ResolvedRepository,
  pr: number,
): Promise<IssueMeta[]> {
  const query = `query($owner: String!, $repo: String!, $pr: Int!) { repository(owner: $owner, name: $repo) { pullRequest(number: $pr) { closingIssuesReferences(first: 20) { nodes { number title body url state author { login } labels(first: 100) { nodes { name } } issueType { name } } } } } }`
  const raw = await exec(
    `gh api${ghHostOption(repository)} graphql -f query=${shellQuote(query)} -F owner=${shellQuote(repository.github.owner)} -F repo=${shellQuote(repository.github.repo)} -F pr=${pr}`,
  )
  const data = JSON.parse(raw) as {
    data?: {
      repository?: {
        pullRequest?: {
          closingIssuesReferences?: {
            nodes?: {
              author?: { login?: string }
              body?: string
              issueType?: { name?: string } | null
              labels?: { nodes?: { name: string }[] }
              number: number
              state: string
              title: string
              url: string
            }[]
          }
        }
      }
    }
  }

  return (
    data.data?.repository?.pullRequest?.closingIssuesReferences?.nodes?.map(
      (issue) => ({
        author: issue.author?.login ?? "",
        body: issue.body ?? "",
        labels: issue.labels?.nodes?.map((label) => label.name) ?? [],
        number: issue.number,
        state: issue.state,
        title: issue.title,
        type: issue.issueType?.name,
        url: issue.url,
      }),
    ) ?? []
  )
}

export async function fetchIssue(
  exec: Exec,
  repository: ResolvedRepository,
  issue: number,
): Promise<IssueMeta> {
  const query = `query($owner: String!, $repo: String!, $issue: Int!) { repository(owner: $owner, name: $repo) { issue(number: $issue) { number title body url state author { login } labels(first: 100) { nodes { name } } issueType { name } } } }`

  try {
    const raw = await exec(
      `gh api${ghHostOption(repository)} graphql -f query=${shellQuote(query)} -F owner=${shellQuote(repository.github.owner)} -F repo=${shellQuote(repository.github.repo)} -F issue=${issue}`,
    )
    const data = JSON.parse(raw) as {
      data?: {
        repository?: {
          issue?: {
            author?: { login?: string }
            body?: string
            issueType?: { name?: string } | null
            labels?: { nodes?: { name: string }[] }
            number: number
            state: string
            title: string
            url: string
          }
        }
      }
    }
    const graphqlIssue = data.data?.repository?.issue

    if (!graphqlIssue) throw new Error(`Could not fetch issue #${issue}`)

    return {
      author: graphqlIssue.author?.login ?? "",
      body: graphqlIssue.body ?? "",
      labels: graphqlIssue.labels?.nodes?.map((label) => label.name) ?? [],
      number: graphqlIssue.number,
      state: graphqlIssue.state,
      title: graphqlIssue.title,
      type: graphqlIssue.issueType?.name,
      url: graphqlIssue.url,
    }
  } catch {
    return fetchIssueWithCli(exec, repository, issue)
  }
}

async function fetchIssueWithCli(
  exec: Exec,
  repository: ResolvedRepository,
  issue: number,
): Promise<IssueMeta> {
  const raw = await exec(
    `gh issue view ${issue} --repo ${shellQuote(repoSpecifier(repository))} --json number,title,body,url,state,author,labels`,
  )
  const data = JSON.parse(raw) as {
    author?: { login?: string }
    body?: string
    labels?: { name: string }[]
    number: number
    state: string
    title: string
    url: string
  }

  return {
    author: data.author?.login ?? "",
    body: data.body ?? "",
    labels: data.labels?.map((label) => label.name) ?? [],
    number: data.number,
    state: data.state,
    title: data.title,
    url: data.url,
  }
}

export async function fetchIssueComments(
  exec: Exec,
  repository: ResolvedRepository,
  issue: number,
  limit = 50,
): Promise<IssueComment[]> {
  return (await fetchIssueCommentPage(exec, repository, issue, limit)).comments
}

export async function fetchIssueCommentPage(
  exec: Exec,
  repository: ResolvedRepository,
  issue: number,
  limit = 50,
): Promise<IssueCommentPage> {
  const query = `query($owner: String!, $repo: String!, $issue: Int!, $limit: Int!) { repository(owner: $owner, name: $repo) { issue(number: $issue) { comments(last: $limit) { totalCount nodes { databaseId author { login } authorAssociation body createdAt url } } } } }`
  const raw = await exec(
    `gh api${ghHostOption(repository)} graphql -f query=${shellQuote(query)} -F owner=${shellQuote(repository.github.owner)} -F repo=${shellQuote(repository.github.repo)} -F issue=${issue} -F limit=${limit}`,
  )
  const data = JSON.parse(raw) as {
    data?: {
      repository?: {
        issue?: {
          comments?: {
            totalCount?: number
            nodes?: {
              author?: { login?: string }
              authorAssociation?: string
              body?: string
              createdAt: string
              databaseId: number
              url: string
            }[]
          }
        }
      }
    }
  }
  const connection = data.data?.repository?.issue?.comments
  const comments =
    connection?.nodes?.map((comment) => ({
      author: comment.author?.login ?? "",
      authorAssociation: comment.authorAssociation,
      body: comment.body ?? "",
      createdAt: comment.createdAt,
      id: comment.databaseId,
      url: comment.url,
    })) ?? []

  return {
    comments,
    omitted: Math.max(
      0,
      (connection?.totalCount ?? comments.length) - comments.length,
    ),
  }
}

export async function fetchPullRequestComments(
  exec: Exec,
  repository: ResolvedRepository,
  pr: number,
  limit = 50,
): Promise<IssueComment[]> {
  return (await fetchPullRequestCommentPage(exec, repository, pr, limit))
    .comments
}

export async function fetchPullRequestCommentPage(
  exec: Exec,
  repository: ResolvedRepository,
  pr: number,
  limit = 50,
): Promise<IssueCommentPage> {
  const query = `query($owner: String!, $repo: String!, $pr: Int!, $limit: Int!) { repository(owner: $owner, name: $repo) { pullRequest(number: $pr) { comments(last: $limit) { totalCount nodes { databaseId author { login } authorAssociation body createdAt url } } } } }`
  const raw = await exec(
    `gh api${ghHostOption(repository)} graphql -f query=${shellQuote(query)} -F owner=${shellQuote(repository.github.owner)} -F repo=${shellQuote(repository.github.repo)} -F pr=${pr} -F limit=${limit}`,
  )
  const data = JSON.parse(raw) as {
    data?: {
      repository?: {
        pullRequest?: {
          comments?: {
            totalCount?: number
            nodes?: {
              author?: { login?: string }
              authorAssociation?: string
              body?: string
              createdAt: string
              databaseId: number
              url: string
            }[]
          }
        }
      }
    }
  }
  const connection = data.data?.repository?.pullRequest?.comments
  const comments =
    connection?.nodes?.map((comment) => ({
      author: comment.author?.login ?? "",
      authorAssociation: comment.authorAssociation,
      body: comment.body ?? "",
      createdAt: comment.createdAt,
      id: comment.databaseId,
      url: comment.url,
    })) ?? []

  return {
    comments,
    omitted: Math.max(
      0,
      (connection?.totalCount ?? comments.length) - comments.length,
    ),
  }
}

export async function fetchRelatedPullRequests(
  exec: Exec,
  repository: ResolvedRepository,
  issue: number,
): Promise<RelatedPullRequest[]> {
  const query = `query($owner: String!, $repo: String!, $issue: Int!) { repository(owner: $owner, name: $repo) { issue(number: $issue) { timelineItems(first: 50, itemTypes: [CONNECTED_EVENT, CROSS_REFERENCED_EVENT]) { nodes { __typename ... on ConnectedEvent { subject { __typename ... on PullRequest { number title url state mergedAt body author { login } } } } ... on CrossReferencedEvent { source { __typename ... on PullRequest { number title url state mergedAt body author { login } } } } } } } } }`
  const raw = await exec(
    `gh api${ghHostOption(repository)} graphql -f query=${shellQuote(query)} -F owner=${shellQuote(repository.github.owner)} -F repo=${shellQuote(repository.github.repo)} -F issue=${issue}`,
  )
  const data = JSON.parse(raw) as {
    data?: {
      repository?: {
        issue?: { timelineItems?: { nodes?: Record<string, unknown>[] } }
      }
    }
  }
  const prs = new Map<number, RelatedPullRequest>()

  for (const node of data.data?.repository?.issue?.timelineItems?.nodes ?? []) {
    const source = (node.subject ?? node.source) as
      | {
          author?: { login?: string }
          body?: string
          mergedAt?: string
          number?: number
          state?: string
          title?: string
          url?: string
        }
      | undefined
    if (!source?.number || !source.url) continue
    const state = source.mergedAt
      ? "MERGED"
      : normalizeRelatedPullRequestState(source.state)
    prs.set(source.number, {
      author: source.author?.login ?? "",
      body: source.body,
      mergedAt: source.mergedAt,
      number: source.number,
      state,
      title: source.title ?? `PR #${source.number}`,
      url: source.url,
    })
  }

  const searchQuery = `repo:${repoSlug(repository)} is:pr ${issue}`
  const searchRaw = await exec(
    `gh search prs ${shellQuote(searchQuery)} --json number,title,url,state,body,author --limit 10`,
  ).catch(() => "[]")
  const searchData = JSON.parse(searchRaw) as {
    author?: { login?: string }
    body?: string
    number: number
    state: string
    title: string
    url: string
  }[]
  const closingReference = new RegExp(
    `\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+#${issue}\\b`,
    "i",
  )

  for (const item of searchData) {
    if (!closingReference.test(item.body ?? "")) continue

    prs.set(item.number, {
      author: item.author?.login ?? "",
      body: item.body,
      number: item.number,
      state: normalizeRelatedPullRequestState(item.state),
      title: item.title,
      url: item.url,
    })
  }

  return [...prs.values()]
}

function duplicateReferences(text: string): number[] {
  const refs = new Set<number>()
  const pattern = /duplicate(?:s)?\s+(?:of\s+)?#(\d+)/gi

  for (const match of text.matchAll(pattern)) refs.add(Number(match[1]))

  return [...refs]
}

function issueTitleSearchQuery(title: string, fallback: string): string {
  return (
    title
      .replaceAll(/[^\p{L}\p{N}_]+/gu, " ")
      .replaceAll(/\s+/g, " ")
      .trim() || fallback
  )
}

async function fetchIssueCandidate(
  exec: Exec,
  repository: ResolvedRepository,
  number: number,
  whyCandidate: string,
): Promise<DuplicateIssueCandidate | undefined> {
  const raw = await exec(
    `gh issue view ${number} --repo ${shellQuote(repoSpecifier(repository))} --json number,title,url,state,body,createdAt`,
  ).catch(() => undefined)
  if (!raw) return undefined
  const data = JSON.parse(raw) as {
    body?: string
    createdAt?: string
    number: number
    state: string
    title: string
    url: string
  }

  return { ...data, whyCandidate }
}

export async function searchDuplicateIssues(
  exec: Exec,
  repository: ResolvedRepository,
  issue: IssueMeta,
  limit = 5,
): Promise<DuplicateIssueCandidate[]> {
  const query = issueTitleSearchQuery(issue.title, String(issue.number))
  const explicitCandidates = await Promise.all(
    duplicateReferences(issue.body)
      .filter((number) => number !== issue.number)
      .map((number) =>
        fetchIssueCandidate(
          exec,
          repository,
          number,
          "Issue body explicitly references a duplicate target.",
        ),
      ),
  )
  const raw = await exec(
    `gh search issues --repo ${shellQuote(repoSlug(repository))} --json number,title,url,state,body --limit ${limit} -- ${shellQuote(query)}`,
  )
  const data = JSON.parse(raw) as {
    body?: string
    number: number
    state: string
    title: string
    url: string
  }[]

  const candidates = new Map<number, DuplicateIssueCandidate>()
  for (const candidate of explicitCandidates) {
    if (candidate) candidates.set(candidate.number, candidate)
  }
  for (const item of data
    .filter((item) => item.number !== issue.number)
    .map((item) => ({
      ...item,
      whyCandidate: "GitHub issue search matched the title.",
    }))) {
    if (!candidates.has(item.number)) candidates.set(item.number, item)
  }

  return [...candidates.values()].slice(0, limit)
}

export async function postIssueComment(
  exec: Exec,
  repository: ResolvedRepository,
  issue: number,
  account: string,
  body: string,
): Promise<PostedIssueComment> {
  const token = await ghToken(exec, repository, account)
  const payloadPath = join(
    tmpdir(),
    `magi-issue-${process.pid}-${Date.now()}.json`,
  )

  await writeFile(payloadPath, JSON.stringify({ body }))

  try {
    const raw = await exec(
      `gh api${ghHostOption(repository)} repos/${repository.github.owner}/${repository.github.repo}/issues/${issue}/comments --method POST --input ${shellQuote(payloadPath)} --jq '{id: .id, url: .html_url}'`,
      ghTokenEnv(token),
    )
    const data = JSON.parse(raw) as { id?: number; url?: string }

    if (!data.id || !data.url)
      throw new Error(
        "GitHub issue comment response did not include id and url",
      )

    return { id: data.id, url: data.url }
  } finally {
    await rm(payloadPath, { force: true })
  }
}

export async function updateIssueComment(
  exec: Exec,
  repository: ResolvedRepository,
  commentId: number,
  account: string,
  body: string,
): Promise<PostedIssueComment> {
  const token = await ghToken(exec, repository, account)
  const payloadPath = join(
    tmpdir(),
    `magi-issue-comment-${process.pid}-${Date.now()}.json`,
  )

  await writeFile(payloadPath, JSON.stringify({ body }))

  try {
    const raw = await exec(
      `gh api${ghHostOption(repository)} repos/${repository.github.owner}/${repository.github.repo}/issues/comments/${commentId} --method PATCH --input ${shellQuote(payloadPath)} --jq '{id: .id, url: .html_url}'`,
      ghTokenEnv(token),
    )
    const data = JSON.parse(raw) as { id?: number; url?: string }

    if (!data.id || !data.url)
      throw new Error(
        "GitHub issue comment response did not include id and url",
      )

    return { id: data.id, url: data.url }
  } finally {
    await rm(payloadPath, { force: true })
  }
}

export async function closeIssue(
  exec: Exec,
  repository: ResolvedRepository,
  issue: number,
  account: string,
): Promise<string> {
  const token = await ghToken(exec, repository, account)

  return exec(
    `gh issue close ${issue} --repo ${shellQuote(repoSpecifier(repository))}`,
    ghTokenEnv(token),
  )
}

export async function assignIssue(
  exec: Exec,
  repository: ResolvedRepository,
  issue: number,
  account: string,
): Promise<string> {
  const token = await ghToken(exec, repository, account)

  return exec(
    `gh issue edit ${issue} --repo ${shellQuote(repoSpecifier(repository))} --add-assignee ${shellQuote(account)}`,
    ghTokenEnv(token),
  )
}

export async function removeIssueLabels(
  exec: Exec,
  repository: ResolvedRepository,
  issue: number,
  labels: string[],
  account: string,
): Promise<string[]> {
  const token = await ghToken(exec, repository, account)
  const removed: string[] = []

  for (const label of labels) {
    await exec(
      `gh issue edit ${issue} --repo ${shellQuote(repoSpecifier(repository))} --remove-label ${shellQuote(label)}`,
      ghTokenEnv(token),
    )
    removed.push(label)
  }

  return removed
}

export async function fetchPullRequestReviews(
  exec: Exec,
  repository: ResolvedRepository,
  pr: number,
): Promise<PullRequestReview[]> {
  const query = `query($owner: String!, $repo: String!, $pr: Int!) { repository(owner: $owner, name: $repo) { pullRequest(number: $pr) { reviews(first: 100) { nodes { author { login } submittedAt state body commit { oid } comments(first: 100) { nodes { body path line startLine } } } } } } }`
  const raw = await exec(
    `gh api${ghHostOption(repository)} graphql -f query=${shellQuote(query)} -F owner=${shellQuote(repository.github.owner)} -F repo=${shellQuote(repository.github.repo)} -F pr=${pr}`,
  )
  const data = JSON.parse(raw) as {
    data: {
      repository: {
        pullRequest: {
          reviews: {
            nodes: Array<
              Omit<PullRequestReview, "comments"> & {
                comments?: { nodes?: PullRequestReviewComment[] }
              }
            >
          }
        }
      }
    }
  }

  return data.data.repository.pullRequest.reviews.nodes.map((review) => ({
    ...review,
    comments: review.comments?.nodes ?? [],
  }))
}

export async function fetchPullRequestCommits(
  exec: Exec,
  repository: ResolvedRepository,
  pr: number,
): Promise<PullRequestCommit[]> {
  const query = `query($owner: String!, $repo: String!, $pr: Int!) { repository(owner: $owner, name: $repo) { pullRequest(number: $pr) { commits(first: 100) { nodes { commit { oid committedDate parents { totalCount } } } } } } }`
  const raw = await exec(
    `gh api${ghHostOption(repository)} graphql -f query=${shellQuote(query)} -F owner=${shellQuote(repository.github.owner)} -F repo=${shellQuote(repository.github.repo)} -F pr=${pr}`,
  )
  const data = JSON.parse(raw) as {
    data: {
      repository: {
        pullRequest: {
          commits: {
            nodes: {
              commit: {
                committedDate: string
                oid: string
                parents: { totalCount: number }
              }
            }[]
          }
        }
      }
    }
  }

  return data.data.repository.pullRequest.commits.nodes.map(({ commit }) => ({
    committedDate: commit.committedDate,
    oid: commit.oid,
    parentCount: commit.parents.totalCount,
  }))
}

export async function fetchPullRequestSafetyMeta(
  exec: Exec,
  repository: ResolvedRepository,
  pr: number,
): Promise<PullRequestSafetyMeta> {
  const query = `query($owner: String!, $repo: String!, $pr: Int!, $filesCursor: String) { repository(owner: $owner, name: $repo) { pullRequest(number: $pr) { author { login } changedFiles labels(first: 100) { nodes { name } } files(first: 100, after: $filesCursor) { nodes { path } pageInfo { hasNextPage endCursor } } } } }`
  const files: string[] = []
  let author = ""
  let changedFiles = 0
  let labels: string[] = []
  let cursor: string | undefined

  for (;;) {
    const cursorFlag = cursor ? ` -F filesCursor=${shellQuote(cursor)}` : ""
    const raw = await exec(
      `gh api${ghHostOption(repository)} graphql -f query=${shellQuote(query)} -F owner=${shellQuote(repository.github.owner)} -F repo=${shellQuote(repository.github.repo)} -F pr=${pr}${cursorFlag}`,
    )
    const data = JSON.parse(raw) as {
      data: {
        repository: {
          pullRequest: {
            author?: { login?: string }
            changedFiles: number
            files: {
              nodes: { path: string }[]
              pageInfo: { endCursor?: string; hasNextPage: boolean }
            }
            labels: { nodes: { name: string }[] }
          }
        }
      }
    }
    const pullRequest = data.data.repository.pullRequest

    author = pullRequest.author?.login ?? author
    changedFiles = pullRequest.changedFiles
    labels = pullRequest.labels.nodes.map((label) => label.name)
    files.push(...pullRequest.files.nodes.map((file) => file.path))

    if (!pullRequest.files.pageInfo.hasNextPage) break
    cursor = pullRequest.files.pageInfo.endCursor
    if (!cursor) break
  }

  return { author, changedFiles, files, labels }
}

export async function watchChecks(
  exec: Exec,
  repository: ResolvedRepository,
  pr: number,
): Promise<void> {
  await exec(
    `gh pr checks ${pr} --repo ${shellQuote(repoSpecifier(repository))} --watch`,
  )
}

export function isCancelledCheck(check: PullRequestCheck): boolean {
  return check.bucket === "cancel" || check.state === "CANCELLED"
}

export function isFailedCheck(check: PullRequestCheck): boolean {
  return check.bucket === "fail" || check.state === "FAILURE"
}

export async function fetchPullRequestChecks(
  exec: Exec,
  repository: ResolvedRepository,
  pr: number,
  options: FetchPullRequestChecksOptions = {},
): Promise<PullRequestCheck[]> {
  let raw: string

  try {
    raw = await exec(
      `gh pr checks ${pr} --repo ${shellQuote(repoSpecifier(repository))} --json name,state,bucket,link,workflow`,
    )
  } catch (error) {
    if (
      options.tolerateMissingChecks &&
      /no checks reported on the '.+' branch/i.test(errorText(error))
    ) {
      return []
    }

    throw error
  }

  return JSON.parse(raw) as PullRequestCheck[]
}

export async function fetchWorkflowRunMeta(
  exec: Exec,
  repository: ResolvedRepository,
  runId: string,
): Promise<WorkflowRunMeta> {
  const endpoint = `repos/${repository.github.owner}/${repository.github.repo}/actions/runs/${runId}`
  const raw = await exec(
    `gh api${ghHostOption(repository)} ${shellQuote(endpoint)}`,
  )
  const data = JSON.parse(raw) as {
    conclusion?: string
    head_sha?: string
    status?: string
  }

  return {
    conclusion: data.conclusion,
    headSha: data.head_sha ?? "",
    status: data.status ?? "",
  }
}

function excludedCheckMatcher(
  pattern: string,
): (check: PullRequestCheck) => boolean {
  if (pattern.startsWith("/") && pattern.endsWith("/") && pattern.length > 1) {
    const regex = new RegExp(pattern.slice(1, -1))

    return (check) => regex.test(check.name)
  }

  return (check) => check.name === pattern
}

export function applyCheckExclusions(input: {
  checks: PullRequestCheck[]
  excluded: PullRequestCheck[]
  patterns: string[]
}): PullRequestCheck[] {
  if (!input.patterns.length) return input.checks

  const matchers = input.patterns.map(excludedCheckMatcher)
  const kept: PullRequestCheck[] = []

  for (const check of input.checks) {
    if (matchers.some((matcher) => matcher(check))) {
      input.excluded.push(check)
      continue
    }

    kept.push(check)
  }

  return kept
}

export function checkJobId(check: PullRequestCheck): string | undefined {
  return check.link.match(/\/actions\/runs\/\d+\/job\/(\d+)/)?.[1]
}

export function checkRunId(check: PullRequestCheck): string | undefined {
  return check.link.match(/\/actions\/runs\/(\d+)\/job\/\d+/)?.[1]
}

export async function rerunCheckJob(
  exec: Exec,
  repository: ResolvedRepository,
  jobId: string,
): Promise<void> {
  await exec(
    `gh run rerun --repo ${shellQuote(repoSpecifier(repository))} --job ${shellQuote(jobId)}`,
  )
}

export async function watchRun(
  exec: Exec,
  repository: ResolvedRepository,
  runId: string,
): Promise<void> {
  await exec(
    `gh run watch ${shellQuote(runId)} --repo ${shellQuote(repoSpecifier(repository))} --exit-status`,
  )
}

export async function fetchCheckFailureLog(
  exec: Exec,
  repository: ResolvedRepository,
  jobId: string,
): Promise<string> {
  return exec(
    `gh run view --repo ${shellQuote(repoSpecifier(repository))} --job ${shellQuote(jobId)} --log-failed`,
  )
}

export async function fetchMergeQueueRequirement(
  exec: Exec,
  repository: ResolvedRepository,
  branch: string,
): Promise<boolean | undefined> {
  const raw = await exec(
    `gh api${ghHostOption(repository)} repos/${repository.github.owner}/${repository.github.repo}/rules/branches/${shellQuote(branch)} -H ${shellQuote("Accept: application/vnd.github+json")}`,
  )
  const rules = JSON.parse(raw) as Array<{ type?: string }>

  return rules.some((rule) => rule.type === "merge_queue")
}

export async function createWorktree(
  exec: Exec,
  repository: ResolvedRepository,
  pr: number,
  root: string,
): Promise<CreatedWorktree> {
  const worktreePath = join(root, `pr-${pr}`)
  const lockKey = `${repoSpecifier(repository)}:${root}`

  return withWorktreeCreateLock(lockKey, async () => {
    let worktreeAdded = false

    try {
      await mkdir(dirname(worktreePath), { recursive: true })
      await exec(`git worktree add --detach ${shellQuote(worktreePath)}`)
      worktreeAdded = true
      await checkoutPullRequestWithRetry(exec, repository, pr, worktreePath)
      const branch = (
        await exec("git branch --show-current", { cwd: worktreePath })
      ).trim()

      return { branch: branch || undefined, path: worktreePath }
    } catch (error) {
      if (worktreeAdded) {
        await removeWorktree(exec, worktreePath).catch(() => undefined)
      }

      throw error
    }
  })
}

export async function removeWorktree(
  exec: Exec,
  worktreePath: string,
): Promise<void> {
  await exec(`git worktree remove --force ${shellQuote(worktreePath)}`)
  await exec("git worktree prune")
}

export async function removeBranch(exec: Exec, branch: string): Promise<void> {
  await exec(`git branch -D ${shellQuote(branch)}`)
}

export async function postApproval(
  exec: Exec,
  repository: ResolvedRepository,
  pr: number,
  account: string,
): Promise<string> {
  const token = await ghToken(exec, repository, account)

  return exec(
    `gh pr review ${pr} --repo ${shellQuote(repoSpecifier(repository))} --approve`,
    ghTokenEnv(token),
  )
}

export async function postCloseComment(
  exec: Exec,
  repository: ResolvedRepository,
  pr: number,
  account: string,
  body: string,
): Promise<string> {
  const token = await ghToken(exec, repository, account)
  const payloadPath = join(
    tmpdir(),
    `magi-close-${process.pid}-${Date.now()}.json`,
  )

  await writeFile(payloadPath, JSON.stringify({ body, event: "COMMENT" }))

  try {
    return await exec(
      `gh api${ghHostOption(repository)} repos/${repository.github.owner}/${repository.github.repo}/pulls/${pr}/reviews --method POST --input ${shellQuote(payloadPath)} --jq .html_url`,
      ghTokenEnv(token),
    )
  } finally {
    await rm(payloadPath, { force: true })
  }
}

function findingComment(finding: Finding): Record<string, unknown> {
  const comment: Record<string, unknown> = {
    body: `**Issue:** ${finding.issue}\n\n**Fix:** ${finding.fix}`,
    line: finding.line,
    path: finding.path,
    side: "RIGHT",
  }

  if (finding.startLine != null) {
    comment.start_line = finding.startLine
    comment.start_side = "RIGHT"
  }

  return comment
}

function changesRequestedBody(findings: Finding[]): string {
  return findings.length === 1
    ? "Changes requested: 1 inline comment."
    : `Changes requested: ${findings.length} inline comments.`
}

export async function postChangesRequested(
  exec: Exec,
  repository: ResolvedRepository,
  pr: number,
  account: string,
  findings: Finding[],
): Promise<string> {
  const token = await ghToken(exec, repository, account)
  const payloadPath = join(
    tmpdir(),
    `magi-review-${process.pid}-${Date.now()}.json`,
  )
  const body = changesRequestedBody(findings)

  await writeFile(
    payloadPath,
    JSON.stringify({
      body,
      comments: findings.map(findingComment),
      event: "REQUEST_CHANGES",
    }),
  )

  try {
    return await exec(
      `gh api${ghHostOption(repository)} repos/${repository.github.owner}/${repository.github.repo}/pulls/${pr}/reviews --method POST --input ${shellQuote(payloadPath)} --jq .html_url`,
      ghTokenEnv(token),
    )
  } finally {
    await rm(payloadPath, { force: true })
  }
}

export async function mergePullRequest(
  exec: Exec,
  repository: ResolvedRepository,
  pr: number,
  account: string,
): Promise<string> {
  const token = await ghToken(exec, repository, account)

  if (repository.merge.mergeQueue) {
    const queueInput = await fetchPullRequestQueueInput(
      exec,
      repository,
      pr,
      token,
    )
    const query = `mutation($pullRequestId: ID!, $expectedHeadOid: GitObjectID!) { enqueuePullRequest(input: { pullRequestId: $pullRequestId, expectedHeadOid: $expectedHeadOid }) { mergeQueueEntry { id } } }`

    return exec(
      `gh api${ghHostOption(repository)} graphql -f query=${shellQuote(query)} -F pullRequestId=${shellQuote(queueInput.id)} -F expectedHeadOid=${shellQuote(queueInput.headRefOid)} --jq .data.enqueuePullRequest.mergeQueueEntry.id`,
      ghTokenEnv(token),
    )
  }

  const methodFlag =
    repository.merge.method === "merge"
      ? "--merge"
      : repository.merge.method === "rebase"
        ? "--rebase"
        : "--squash"
  const autoFlag = repository.merge.auto ? " --auto" : ""
  const deleteFlag = repository.merge.deleteBranch ? " --delete-branch" : ""

  return exec(
    `gh pr merge ${pr} --repo ${shellQuote(repoSpecifier(repository))} ${methodFlag}${autoFlag}${deleteFlag}`,
    ghTokenEnv(token),
  )
}

export async function fetchPullRequestMergeStatus(
  exec: Exec,
  repository: ResolvedRepository,
  pr: number,
): Promise<PullRequestMergeStatus> {
  const json = await exec(
    `gh pr view ${pr} --repo ${shellQuote(repoSpecifier(repository))} --json state,mergeStateStatus,autoMergeRequest`,
  )

  return JSON.parse(json) as PullRequestMergeStatus
}

export async function fetchPullRequestQueueStatus(
  exec: Exec,
  repository: ResolvedRepository,
  pr: number,
): Promise<PullRequestQueueStatus> {
  const query = `query($owner: String!, $repo: String!, $pr: Int!) { repository(owner: $owner, name: $repo) { pullRequest(number: $pr) { state isInMergeQueue mergeQueueEntry { id } } } }`
  const raw = await exec(
    `gh api${ghHostOption(repository)} graphql -f query=${shellQuote(query)} -F owner=${shellQuote(repository.github.owner)} -F repo=${shellQuote(repository.github.repo)} -F pr=${pr}`,
  )
  const data = JSON.parse(raw) as {
    data?: {
      repository?: {
        pullRequest?: PullRequestQueueStatus
      }
    }
  }
  const status = data.data?.repository?.pullRequest

  if (!status) throw new Error(`Could not fetch merge queue status for #${pr}`)

  return status
}

export async function waitForMergeQueue(
  exec: Exec,
  repository: ResolvedRepository,
  pr: number,
  intervalMs = 30_000,
): Promise<"dequeued" | "merged"> {
  for (;;) {
    const status = await fetchPullRequestQueueStatus(exec, repository, pr)

    if (status.state === "MERGED") return "merged"
    if (
      status.state === "OPEN" &&
      !status.isInMergeQueue &&
      status.mergeQueueEntry == null
    ) {
      return "dequeued"
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

export async function closePullRequest(
  exec: Exec,
  repository: ResolvedRepository,
  pr: number,
  account: string,
): Promise<string> {
  const token = await ghToken(exec, repository, account)

  return exec(
    `gh pr close ${pr} --repo ${shellQuote(repoSpecifier(repository))}`,
    ghTokenEnv(token),
  )
}

export async function pushHead(
  exec: Exec,
  repository: ResolvedRepository,
  worktreePath: string,
  account: string,
  head: { owner: string; ref: string; repo: string },
): Promise<void> {
  const token = await ghToken(exec, repository, account)
  const url = repositoryGitUrl(repository, head.owner, head.repo)

  await exec(
    `git push ${shellQuote(url)} ${shellQuote(`HEAD:refs/heads/${head.ref}`)}`,
    {
      cwd: worktreePath,
      env: {
        GIT_CONFIG_COUNT: "2",
        GIT_CONFIG_KEY_0: "credential.helper",
        GIT_CONFIG_KEY_1: "credential.helper",
        GIT_CONFIG_VALUE_0: "",
        GIT_CONFIG_VALUE_1:
          "!f() { echo username=x-access-token; echo password=$GIT_PASSWORD; }; f",
        GIT_PASSWORD: token,
        GIT_TERMINAL_PROMPT: "0",
      },
    },
  )
}

export async function createPullRequest(
  exec: Exec,
  repository: ResolvedRepository,
  account: string,
  input: { base?: string; body: string; head: string; title: string },
): Promise<string> {
  const token = await ghToken(exec, repository, account)
  const baseFlag = input.base ? ` --base ${shellQuote(input.base)}` : ""

  return exec(
    `gh pr create --repo ${shellQuote(repoSpecifier(repository))} --head ${shellQuote(input.head)}${baseFlag} --title ${shellQuote(input.title)} --body ${shellQuote(input.body)}`,
    ghTokenEnv(token),
  )
}

export async function configureGitIdentity(
  exec: Exec,
  worktreePath: string,
  identity: { email?: string; name?: string },
): Promise<void> {
  if (identity.name) {
    await exec(`git config --worktree user.name ${shellQuote(identity.name)}`, {
      cwd: worktreePath,
    })
  }

  if (identity.email) {
    await exec(
      `git config --worktree user.email ${shellQuote(identity.email)}`,
      {
        cwd: worktreePath,
      },
    )
  }
}

export async function fetchUnresolvedThreads(
  exec: Exec,
  repository: ResolvedRepository,
  pr: number,
  author?: string,
): Promise<ReviewThread[]> {
  const query = `query($owner: String!, $repo: String!, $pr: Int!) { repository(owner: $owner, name: $repo) { pullRequest(number: $pr) { reviewThreads(first: 100) { nodes { id isResolved comments(first: 50) { nodes { databaseId author { login } path line body createdAt } } } } } } }`
  const raw = await exec(
    `gh api${ghHostOption(repository)} graphql -f query=${shellQuote(query)} -F owner=${shellQuote(repository.github.owner)} -F repo=${shellQuote(repository.github.repo)} -F pr=${pr}`,
  )
  const data = JSON.parse(raw)
  const threads = data.data.repository.pullRequest.reviewThreads
    .nodes as Array<{
    comments: {
      nodes: Array<{
        databaseId: number
        author: { login: string }
        path: string
        line: number
        body: string
        createdAt: string
      }>
    }
    id: string
    isResolved: boolean
  }>

  return threads.flatMap<ReviewThread>((thread) => {
    if (thread.isResolved || !thread.comments.nodes.length) return []

    const comments = [...thread.comments.nodes]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((comment) => ({
        author: comment.author.login,
        body: comment.body,
        commentId: comment.databaseId,
        createdAt: comment.createdAt,
      }))
    const first = thread.comments.nodes[0]

    if (!author)
      return [
        {
          body: first.body,
          commentId: first.databaseId,
          comments,
          line: first.line,
          path: first.path,
          threadId: thread.id,
        },
      ]
    if (first.author.login !== author) return []

    const authored = thread.comments.nodes.filter(
      (comment) => comment.author.login === author,
    )
    const latest =
      authored.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1) ??
      first

    return [
      {
        commentId: first.databaseId,
        comments,
        latestBody: latest.body,
        line: first.line,
        path: first.path,
        threadId: thread.id,
      },
    ]
  })
}

export async function fetchPullRequestReviewThreads(
  exec: Exec,
  repository: ResolvedRepository,
  pr: number,
  threadLimit = 50,
  commentsPerThread = 20,
): Promise<ReviewThread[]> {
  return (
    await fetchPullRequestReviewThreadPage(
      exec,
      repository,
      pr,
      threadLimit,
      commentsPerThread,
    )
  ).threads
}

export async function fetchPullRequestReviewThreadPage(
  exec: Exec,
  repository: ResolvedRepository,
  pr: number,
  threadLimit = 50,
  commentsPerThread = 20,
): Promise<PullRequestReviewThreadPage> {
  const query = `query($owner: String!, $repo: String!, $pr: Int!, $threadLimit: Int!, $commentsPerThread: Int!) { repository(owner: $owner, name: $repo) { pullRequest(number: $pr) { reviewThreads(last: $threadLimit) { totalCount nodes { id isResolved comments(last: $commentsPerThread) { totalCount nodes { databaseId author { login } path line body createdAt } } } } } } }`
  const raw = await exec(
    `gh api${ghHostOption(repository)} graphql -f query=${shellQuote(query)} -F owner=${shellQuote(repository.github.owner)} -F repo=${shellQuote(repository.github.repo)} -F pr=${pr} -F threadLimit=${threadLimit} -F commentsPerThread=${commentsPerThread}`,
  )
  const data = JSON.parse(raw) as {
    data?: {
      repository?: {
        pullRequest?: {
          reviewThreads?: {
            totalCount?: number
            nodes?: Array<{
              comments: {
                totalCount?: number
                nodes: Array<{
                  author?: { login?: string }
                  body?: string
                  createdAt: string
                  databaseId: number
                  line: number
                  path: string
                }>
              }
              id: string
              isResolved: boolean
            }>
          }
        }
      }
    }
  }
  const connection = data.data?.repository?.pullRequest?.reviewThreads
  const nodes = connection?.nodes ?? []
  const threads = nodes.flatMap((thread) => {
    const comments = [...thread.comments.nodes]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((comment) => ({
        author: comment.author?.login ?? "",
        body: comment.body ?? "",
        commentId: comment.databaseId,
        createdAt: comment.createdAt,
      }))
    const first = thread.comments.nodes[0]

    if (!first) return []

    return [
      {
        body: first.body ?? "",
        commentId: first.databaseId,
        comments,
        isResolved: thread.isResolved,
        line: first.line,
        omittedComments: Math.max(
          0,
          (thread.comments.totalCount ?? comments.length) - comments.length,
        ),
        path: first.path,
        threadId: thread.id,
      },
    ]
  })

  return {
    omitted: Math.max(
      0,
      (connection?.totalCount ?? threads.length) - threads.length,
    ),
    threads,
  }
}

export async function postReply(
  exec: Exec,
  repository: ResolvedRepository,
  pr: number,
  account: string,
  commentId: number,
  body: string,
): Promise<string> {
  const token = await ghToken(exec, repository, account)
  const payloadPath = join(
    tmpdir(),
    `magi-reply-${process.pid}-${Date.now()}-${commentId}.json`,
  )

  await writeFile(payloadPath, JSON.stringify({ body }))

  try {
    return await exec(
      `gh api${ghHostOption(repository)} repos/${repository.github.owner}/${repository.github.repo}/pulls/${pr}/comments/${commentId}/replies --method POST --input ${shellQuote(payloadPath)} --jq .html_url`,
      ghTokenEnv(token),
    )
  } finally {
    await rm(payloadPath, { force: true })
  }
}

export async function resolveThread(
  exec: Exec,
  repository: ResolvedRepository,
  account: string,
  threadId: string,
): Promise<void> {
  const token = await ghToken(exec, repository, account)
  const query = `mutation($threadId: ID!) { resolveReviewThread(input: { threadId: $threadId }) { thread { id } } }`

  await exec(
    `gh api${ghHostOption(repository)} graphql -f query=${shellQuote(query)} -F threadId=${shellQuote(threadId)}`,
    ghTokenEnv(token),
  )
}
