import type { Exec, Finding, ResolvedRepository } from "../types"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

export interface PullRequestMeta {
  baseRefName: string
  baseRefOid: string
  headRepository?: { name?: string }
  headRepositoryOwner?: { login?: string }
  headRefName: string
  headRefOid: string
  isDraft: boolean
  number: number
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

export interface WorkflowRunMeta {
  conclusion?: string
  headSha: string
  status: string
}

export interface ReviewThread {
  body?: string
  commentId: number
  comments: ReviewThreadComment[]
  latestBody?: string
  line: number
  path: string
  threadId: string
}

export interface ReviewThreadComment {
  author: string
  body: string
  commentId: number
  createdAt: string
}

export interface PullRequestReview {
  author: { login: string }
  body?: string
  commit?: { oid: string }
  state: string
  submittedAt: string
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

export async function fetchPullRequest(
  exec: Exec,
  repository: ResolvedRepository,
  pr: number,
): Promise<PullRequestMeta> {
  const json = await exec(
    `gh pr view ${pr} --repo ${shellQuote(repoSpecifier(repository))} --json number,title,url,isDraft,baseRefOid,headRefOid,baseRefName,headRefName,headRepository,headRepositoryOwner`,
  )

  return JSON.parse(json) as PullRequestMeta
}

export async function fetchPullRequestReviews(
  exec: Exec,
  repository: ResolvedRepository,
  pr: number,
): Promise<PullRequestReview[]> {
  const query = `query($owner: String!, $repo: String!, $pr: Int!) { repository(owner: $owner, name: $repo) { pullRequest(number: $pr) { reviews(first: 100) { nodes { author { login } submittedAt state body commit { oid } } } } } }`
  const raw = await exec(
    `gh api${ghHostOption(repository)} graphql -f query=${shellQuote(query)} -F owner=${shellQuote(repository.github.owner)} -F repo=${shellQuote(repository.github.repo)} -F pr=${pr}`,
  )
  const data = JSON.parse(raw) as {
    data: {
      repository: {
        pullRequest: { reviews: { nodes: PullRequestReview[] } }
      }
    }
  }

  return data.data.repository.pullRequest.reviews.nodes
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
  const query = `query($owner: String!, $repo: String!, $pr: Int!, $filesCursor: String) { repository(owner: $owner, name: $repo) { pullRequest(number: $pr) { author { login } changedFiles labels(first: 100) { nodes { name } } files(first: 100, after: $filesCursor) { nodes { path } pageInfo { hasNextPage endCursor } } } } } }`
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

export async function waitForChecks(
  exec: Exec,
  repository: ResolvedRepository,
  pr: number,
  enabled = repository.checks.waitBeforeReview,
): Promise<CheckWaitReport | undefined> {
  if (!enabled) return undefined

  const report: CheckWaitReport = {
    attempts: 0,
    excluded: [],
    failed: [],
    rerun: [],
    scopeInside: [],
    scopeOutsideRecovered: [],
    scopeOutsideUnresolved: [],
  }

  try {
    await watchChecks(exec, repository, pr)
    return report
  } catch {
    report.failed = applyCheckExclusions({
      checks: await fetchFailedChecks(exec, repository, pr),
      excluded: report.excluded,
      patterns: repository.checks.exclude,
    })
    return report
  }
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

export async function fetchFailedChecks(
  exec: Exec,
  repository: ResolvedRepository,
  pr: number,
): Promise<PullRequestCheck[]> {
  const checks = await fetchPullRequestChecks(exec, repository, pr)

  return checks.filter(
    (check) => isFailedCheck(check) || isCancelledCheck(check),
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
): Promise<PullRequestCheck[]> {
  const raw = await exec(
    `gh pr checks ${pr} --repo ${shellQuote(repoSpecifier(repository))} --json name,state,bucket,link,workflow`,
  )

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
    `GH_TOKEN=${shellQuote(token)} gh pr review ${pr} --repo ${shellQuote(repoSpecifier(repository))} --approve`,
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
      `GH_TOKEN=${shellQuote(token)} gh api${ghHostOption(repository)} repos/${repository.github.owner}/${repository.github.repo}/pulls/${pr}/reviews --method POST --input ${shellQuote(payloadPath)} --jq .html_url`,
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
  const body = findings
    .map((finding) => `- ${finding.issue.split("\n")[0]}`)
    .join("\n")

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
      `GH_TOKEN=${shellQuote(token)} gh api${ghHostOption(repository)} repos/${repository.github.owner}/${repository.github.repo}/pulls/${pr}/reviews --method POST --input ${shellQuote(payloadPath)} --jq .html_url`,
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
  const methodFlag =
    repository.merge.method === "merge"
      ? "--merge"
      : repository.merge.method === "rebase"
        ? "--rebase"
        : "--squash"
  const autoFlag = repository.merge.auto ? " --auto" : ""
  const deleteFlag = repository.merge.deleteBranch ? " --delete-branch" : ""
  const mergeFlags = repository.merge.mergeQueue
    ? ""
    : ` ${methodFlag}${autoFlag}${deleteFlag}`

  return exec(
    `GH_TOKEN=${shellQuote(token)} gh pr merge ${pr} --repo ${shellQuote(repoSpecifier(repository))}${mergeFlags}`,
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

export async function waitForMergeQueue(
  exec: Exec,
  repository: ResolvedRepository,
  pr: number,
  intervalMs = 30_000,
): Promise<"dequeued" | "merged"> {
  for (;;) {
    const status = await fetchPullRequestMergeStatus(exec, repository, pr)

    if (status.state === "MERGED") return "merged"
    if (status.state === "OPEN" && status.autoMergeRequest == null) {
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
    `GH_TOKEN=${shellQuote(token)} gh pr close ${pr} --repo ${shellQuote(repoSpecifier(repository))}`,
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
    `git -c credential.helper= -c credential.helper=${shellQuote(`!f() { echo username=x-access-token; echo password=${token}; }; f`)} push ${shellQuote(url)} ${shellQuote(`HEAD:refs/heads/${head.ref}`)}`,
    { cwd: worktreePath },
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
      `GH_TOKEN=${shellQuote(token)} gh api${ghHostOption(repository)} repos/${repository.github.owner}/${repository.github.repo}/pulls/${pr}/comments/${commentId}/replies --method POST --input ${shellQuote(payloadPath)} --jq .html_url`,
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
    `GH_TOKEN=${shellQuote(token)} gh api${ghHostOption(repository)} graphql -f query=${shellQuote(query)} -F threadId=${shellQuote(threadId)}`,
  )
}
