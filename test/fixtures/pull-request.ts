import type { Octokit } from "octokit"
import type { Config } from "@/config"
import type { Graphql } from "@/graphql"
import type { PullRequestMetadata } from "@/tools/review"
import type { Exec } from "@/utils"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { DEFAULT_CONFIG } from "@/constant"
import { createExec } from "@/utils"

export const PULL_REQUEST = {
  number: 123,
  owner: "magi-ai",
  repo: "opencode-magi",
} as const
export const REVIEWERS = [
  "reviewer-one",
  "reviewer-two",
  "reviewer-three",
] as const

export interface RepositoryFixture {
  baseSha: string
  exec: Exec
  headSha: string
}

export interface GitHubFixture {
  createReplyForReviewComment: ReturnType<typeof vi.fn>
  createReview: ReturnType<typeof vi.fn>
  get: ReturnType<typeof vi.fn>
  graphql: Graphql
  graphqlPaginate: ReturnType<typeof vi.fn>
  octokit: Octokit
  octokitPaginate: ReturnType<typeof vi.fn>
  resolveReviewThread: ReturnType<typeof vi.fn>
}

export interface PullRequestTarget {
  number: number
  owner: string
  repo: string
}

export function createPullRequestConfig(
  directory: string,
  mode: Config.Mode,
): Config.Root {
  const config = structuredClone(DEFAULT_CONFIG)

  config.account = "review-bot"
  config.github.owner = PULL_REQUEST.owner
  config.github.repo = PULL_REQUEST.repo
  config.github.url = `https://github.com/${PULL_REQUEST.owner}/${PULL_REQUEST.repo}`
  config.merge.automation.close = false
  config.merge.automation.conflict = false
  config.merge.automation.merge = false
  config.merge.editor = {
    account: mode === "single" ? "review-bot" : "editor-account",
    author: { email: "editor@example.com", name: "Editor" },
    model: { id: "test/editor" },
    permissions: "allow",
  }
  config.mode = mode
  config.output.repairAttempts = 1
  config.review.automation.close = false
  config.review.automation.merge = false
  config.review.checks.wait = false
  config.review.concurrency.runs = 1
  config.review.operator = "reviewer-one"
  config.review.output = join(directory, "runs")
  config.review.reviewers = REVIEWERS.map((id) => ({
    account: mode === "single" ? "review-bot" : `${id}-account`,
    id,
    model: { id: "test/reviewer" },
    permissions: "allow",
  }))
  config.review.worktree = join(directory, "worktrees")

  return config
}

export async function createRepository(
  directory: string,
): Promise<RepositoryFixture> {
  const exec = createExec(directory)
  const file = join(directory, "reviewed.txt")

  await exec("git init --initial-branch=main")
  await exec("git config user.name 'Magi Test'")
  await exec("git config user.email 'magi-test@example.com'")
  await writeFile(file, "base\n")
  await exec("git add reviewed.txt")
  await exec("git commit -m 'base'")

  const baseSha = await exec("git rev-parse HEAD")

  await exec("git switch -c feature")
  await writeFile(file, "base\nfeature\n")
  await exec("git add reviewed.txt")
  await exec("git commit -m 'feature'")

  const headSha = await exec("git rev-parse HEAD")

  await exec("git switch main")

  return { baseSha, exec, headSha }
}

export function createPullRequestMetadata(
  directory: string,
  { baseSha, headSha }: RepositoryFixture,
): PullRequestMetadata {
  return {
    base: {
      ref: "main",
      repo: { clone_url: directory },
      sha: baseSha,
    },
    changed_files: 1,
    draft: false,
    head: {
      ref: "feature",
      repo: {
        clone_url: directory,
        name: "opencode-magi",
        owner: { login: "author" },
      },
      sha: headSha,
    },
    labels: [],
    node_id: "pull-request-node",
    state: "open",
    user: { login: "author" },
  } as unknown as PullRequestMetadata
}

export function createGitHubFixture(
  metadata: PullRequestMetadata,
  { number, owner, repo }: PullRequestTarget,
): GitHubFixture {
  const get = vi.fn().mockResolvedValue({ data: metadata })
  const listComments = vi.fn()
  const listCommits = vi.fn()
  const listFiles = vi.fn()
  const listReviews = vi.fn()
  const createReplyForReviewComment = vi.fn()
  const createReview = vi.fn().mockResolvedValue({
    data: {
      html_url: `https://github.com/${owner}/${repo}/pull/${number}#review`,
    },
  })
  const paginate = vi.fn().mockImplementation((request) => {
    if (request === listFiles)
      return Promise.resolve([{ filename: "reviewed.txt" }])
    if (
      request === listComments ||
      request === listCommits ||
      request === listReviews
    )
      return Promise.resolve([])

    return Promise.reject(new Error("Unexpected Octokit pagination request."))
  })
  const octokit = {
    paginate,
    rest: {
      issues: { listComments },
      pulls: {
        createReplyForReviewComment,
        createReview,
        get,
        listCommits,
        listFiles,
        listReviews,
      },
    },
  } as unknown as Octokit
  const closingIssues = vi.fn()
  const reviewThreads = vi.fn()
  const resolveReviewThread = vi.fn()
  const graphqlPaginate = vi.fn().mockImplementation((request) => {
    if (request === closingIssues)
      return Promise.resolve({
        repository: {
          pullRequest: { closingIssuesReferences: { nodes: [] } },
        },
      })
    if (request === reviewThreads)
      return Promise.resolve({
        repository: { pullRequest: { reviewThreads: { nodes: [] } } },
      })

    return Promise.reject(new Error("Unexpected GraphQL pagination request."))
  })
  const graphql = {
    closingIssues,
    paginate: graphqlPaginate,
    resolveReviewThread,
    reviewThreads,
  } as unknown as Graphql

  return {
    createReplyForReviewComment,
    createReview,
    get,
    graphql,
    graphqlPaginate,
    octokit,
    octokitPaginate: paginate,
    resolveReviewThread,
  }
}

export function createPullRequestExec(
  repository: RepositoryFixture,
  { number, owner, repo }: PullRequestTarget,
  ghCommands: string[],
): Exec {
  return async function (command, options): Promise<string> {
    if (!command.startsWith("gh ")) return repository.exec(command, options)

    ghCommands.push(command)

    if (command === `gh pr checkout ${number} --detach`)
      return repository.exec(
        `git checkout --detach '${repository.headSha}'`,
        options,
      )
    if (
      command ===
      `gh pr checks ${number} --repo '${owner}/${repo}' --json name,state,bucket,link,workflow --required`
    )
      return "[]"

    throw new Error(`Unexpected GitHub CLI command: ${command}`)
  }
}
