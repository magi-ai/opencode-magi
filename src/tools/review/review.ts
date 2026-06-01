import type { ToolContext } from "@opencode-ai/plugin"
import type { Octokit } from "octokit"
import type { Config } from "@/config"
import type {
  ClosingIssuesQuery,
  ExpectNode,
  Graphql,
  ReviewThreadsQuery,
} from "@/graphql"
import type { AgentState, Magi, State } from "@/magi"
import type { Exec } from "@/utils"
import { join } from "node:path"
import picomatch from "picomatch"
import { MagiError } from "@/magi"
import {
  command,
  createExecWithGitHubApiRetry,
  filterEmpty,
  isNumber,
  quote,
  toTitleCase,
} from "@/utils"

export interface PullRequestCheck {
  bucket?: string
  name: string
  state?: string
}

export interface PullRequestChecks {
  excluded: PullRequestCheck[]
  failed: PullRequestCheck[]
  passed: PullRequestCheck[]
  pending: PullRequestCheck[]
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

const ci = {
  isExcluded(exclude: string[], { name }: PullRequestCheck) {
    return exclude.some((pattern) => {
      if (
        pattern.startsWith("/") &&
        pattern.endsWith("/") &&
        pattern.length > 1
      ) {
        return new RegExp(pattern.slice(1, -1)).test(name)
      }

      return pattern === name
    })
  },
  isFailed(check: PullRequestCheck) {
    return check.bucket === "fail" || check.state === "FAILURE"
  },
  isPassed(check: PullRequestCheck) {
    return check.bucket === "pass" || check.state === "SUCCESS"
  },
  isPending(check: PullRequestCheck) {
    return !this.isFailed(check) && !this.isPassed(check)
  },
}

interface ReviewOptions {
  dryRun: boolean
}

export class Review {
  public state: State

  constructor(
    private number: number,
    private magi: Magi,
    private config: Config.Root,
    private context: ToolContext,
    private octokit: Octokit,
    private graphql: Graphql,
    private exec: Exec,
    state: State,
  ) {
    this.exec = createExecWithGitHubApiRetry(
      this.magi.exec,
      this.config.github.retryApiAttempts,
    )
    this.state = state
  }

  static async init(
    number: number,
    magi: Magi,
    config: Config.Root,
    context: ToolContext,
    options: ReviewOptions,
  ) {
    const url = `${config.github.url}/pull/${number}`
    const octokit = await magi.createOctokit(config, context.abort)
    const graphql = magi.createGraphql(octokit)
    const state = await magi.createState(
      join(config.review.output, number.toString()),
      {
        command: "review",
        dryRun: options.dryRun,
        pr: { number, url },
        repo: quote(`${config.github.owner}/${config.github.repo}`),
        sessionId: context.sessionID,
        text: `Started reviewing [#${number}](${url}).`,
      },
    )
    const exec = createExecWithGitHubApiRetry(
      magi.exec,
      config.github.retryApiAttempts,
    )

    return new Review(
      number,
      magi,
      config,
      context,
      octokit,
      graphql,
      exec,
      state,
    )
  }

  public getLink() {
    return `[#${this.state.pr!.number}](${this.state.pr!.url})`
  }

  public async checkPr() {
    this.context.abort.throwIfAborted()

    await this.magi.updateState(this.state.output, {
      status: "running",
      text: `Checking PR ${this.getLink()}.`,
    })

    const { files, metadata } = await this.getMetadata()

    if (metadata.state !== "open")
      throw new MagiError("blocked", `PR is not open.`)
    if (metadata.draft) throw new MagiError("blocked", `PR is a draft.`)

    const errors: string[] = []

    if (this.config.review.safety.allowAuthors.length) {
      if (!this.config.review.safety.allowAuthors.includes(metadata.user.login))
        errors.push(`Author is not allowed: ${metadata.user.login}.`)
    }

    if (this.config.review.safety.requiredLabels.length) {
      const missingLabels = this.config.review.safety.requiredLabels.filter(
        (label) => !metadata.labels.some(({ name }) => name === label),
      )

      if (missingLabels.length)
        errors.push(`Required labels missing: ${missingLabels.join(", ")}.`)
    }

    if (
      isNumber(this.config.review.safety.maxChangedFiles) &&
      metadata.changed_files > this.config.review.safety.maxChangedFiles
    ) {
      errors.push(
        `Changed files exceed limit: ${metadata.changed_files} > ${this.config.review.safety.maxChangedFiles}.`,
      )
    }

    if (this.config.review.safety.blockedPaths.length) {
      const isBlocked = picomatch(this.config.review.safety.blockedPaths, {
        dot: true,
      })
      const blocked = files.filter((file) => isBlocked(file))

      if (blocked.length)
        errors.push(`Blocked paths changed: ${blocked.join(", ")}.`)
    }

    if (errors.length) {
      throw new MagiError(
        "blocked",
        `PR is safety blocked. ${errors.join(" ")}`,
      )
    }

    this.state = await this.magi.updateState(this.state.output, {
      pr: { files, metadata },
      text: `Finished checking PR ${this.getLink()}.`,
    })
  }

  public async checkCi() {
    this.context.abort.throwIfAborted()

    this.state = await this.magi.updateState(this.state.output, {
      text: `Checking CI for ${this.getLink()}.`,
    })

    if (this.config.review.checks.wait) await this.watchChecks()

    const checks = await this.getChecks()

    this.state = await this.magi.updateState(this.state.output, {
      checks,
      text: `Finished checking CI for ${this.getLink()}.`,
    })
  }

  public async checkExistingReviews() {
    this.context.abort.throwIfAborted()

    this.state = await this.magi.updateState(this.state.output, {
      text: `Fetching existing reviews for ${this.getLink()}.`,
    })

    if (!this.state.pr?.metadata)
      throw new MagiError("blocked", "PR metadata not found.")
    if (!this.config.review.reviewers?.length)
      throw new MagiError("blocked", "No reviewers configured.")

    const [reviews, commits] = await Promise.all([
      this.getReviews(),
      this.getCommits(),
    ])
    this.state = await this.magi.updateState(this.state.output, {
      pr: { commits, reviews },
    })
    const latestNonMergeCommit = commits
      .toReversed()
      .find(({ parents }) => parents.length < 2)
    const reviewers: { [key: string]: AgentState } = Object.fromEntries(
      this.config.review.reviewers.map(({ account, id }) => {
        const targetReviews = reviews.filter(
          ({ state, user }) => state !== "DISMISSED" && user!.login === account,
        )

        if (!targetReviews.length) {
          return [id, { account, status: "initial" }]
        } else {
          const latestReview = targetReviews.filter(
            ({ submitted_at }) =>
              latestNonMergeCommit?.commit.author?.date &&
              submitted_at &&
              submitted_at.localeCompare(
                latestNonMergeCommit.commit.author.date,
              ) >= 0,
          )

          if (latestReview.length) {
            return [id, { account, status: "skip" }]
          } else {
            return [id, { account, status: "rereview" }]
          }
        }
      }),
    )
    const skip = Object.values(reviewers).every(
      ({ status }) => status === "skip",
    )

    this.state = await this.magi.updateState(this.state.output, {
      reviewers,
      text: `Finished fetching existing reviews for ${this.getLink()}.`,
    })

    if (skip)
      throw new MagiError(
        "blocked",
        "PR has already been reviewed by all configured accounts.",
      )
  }

  public async fetchReviewContext() {
    this.context.abort.throwIfAborted()

    this.state = await this.magi.updateState(this.state.output, {
      text: `Fetching review context for ${this.getLink()}.`,
    })

    const [comments, issues, threads] = await Promise.all([
      this.getComments(),
      this.getClosingIssues(),
      this.getReviewThreads(),
    ])

    this.state = await this.magi.updateState(this.state.output, {
      pr: { comments, issues, threads },
      text: `Finished fetching review context for ${this.getLink()}.`,
    })
  }

  public async createWorktree() {
    this.context.abort.throwIfAborted()

    this.state = await this.magi.updateState(this.state.output, {
      text: `Creating worktree for ${this.getLink()}.`,
    })

    const worktree = await this.magi.createWorktree(
      this.config.review.worktree,
      this.number,
      this.state.id,
      this.context.abort,
    )

    this.state = await this.magi.updateState(this.state.output, {
      text: `Finished creating worktree for ${this.getLink()}.`,
      worktree,
    })
  }

  public async createReport(e?: unknown) {
    if (!e) {
      return this.magi.updateState(this.state.output, {
        completedAt: new Date().toISOString(),
        status: "completed",
        text: `Finished reviewing ${this.getLink()}.`,
      })
    } else {
      const error = e instanceof Error ? e.message : "Unknown error"
      const status =
        e instanceof MagiError
          ? e.status
          : this.context.abort.aborted
            ? "cancelled"
            : "failed"

      return this.magi.updateState(this.state.output, {
        completedAt: new Date().toISOString(),
        error,
        status,
        text: `${toTitleCase(status)} reviewing ${this.getLink()}: ${error}`,
      })
    }
  }

  private async getMetadata() {
    const [{ data }, files] = await Promise.all([
      this.octokit.rest.pulls.get({
        owner: this.config.github.owner,
        pull_number: this.number,
        repo: this.config.github.repo,
      }),
      this.octokit.paginate(this.octokit.rest.pulls.listFiles, {
        owner: this.config.github.owner,
        pull_number: this.number,
        repo: this.config.github.repo,
      }),
    ])

    return { files: files.map(({ filename }) => filename), metadata: data }
  }

  private async getComments() {
    return await this.octokit.paginate(this.octokit.rest.issues.listComments, {
      issue_number: this.number,
      owner: this.config.github.owner,
      repo: this.config.github.repo,
    })
  }

  private async getClosingIssues(): Promise<PullRequestClosingIssue[]> {
    const data = await this.graphql.paginate(this.graphql.closingIssues, {
      owner: this.config.github.owner,
      pr: this.number,
      repo: this.config.github.repo,
    })

    return filterEmpty(
      data.repository?.pullRequest?.closingIssuesReferences?.nodes?.map(
        (node) =>
          node && { ...node, comments: filterEmpty(node.comments.nodes ?? []) },
      ) ?? [],
    )
  }

  private async getReviewThreads() {
    const data = await this.graphql.paginate(this.graphql.reviewThreads, {
      owner: this.config.github.owner,
      pr: this.number,
      repo: this.config.github.repo,
    })

    return filterEmpty(
      data.repository?.pullRequest?.reviewThreads.nodes?.map(
        (node) =>
          node && { ...node, comments: filterEmpty(node.comments.nodes ?? []) },
      ) ?? [],
    )
  }

  private async getReviews() {
    return await this.octokit.paginate(this.octokit.rest.pulls.listReviews, {
      owner: this.config.github.owner,
      pull_number: this.number,
      repo: this.config.github.repo,
    })
  }

  private async getCommits() {
    return await this.octokit.paginate(this.octokit.rest.pulls.listCommits, {
      owner: this.config.github.owner,
      pull_number: this.number,
      repo: this.config.github.repo,
    })
  }

  private async getChecks() {
    const fields = "name,state,bucket,link,workflow"

    try {
      const raw = await this.exec(
        command(
          "gh",
          "pr",
          "checks",
          this.number,
          "--repo",
          this.state.repo,
          "--json",
          fields,
          "--required",
        ),
        { signal: this.context.abort },
      )

      return (JSON.parse(raw) as PullRequestCheck[]).reduce<PullRequestChecks>(
        (prev, check) => {
          if (ci.isExcluded(this.config.review.checks.exclude, check)) {
            prev.excluded.push(check)
          } else if (ci.isFailed(check)) {
            prev.failed.push(check)
          } else if (ci.isPassed(check)) {
            prev.passed.push(check)
          } else if (ci.isPending(check)) {
            prev.pending.push(check)
          }

          return prev
        },
        { excluded: [], failed: [], passed: [], pending: [] },
      )
    } catch (e) {
      if (/no checks reported on the '.+' branch/i.test(String(e)))
        return { excluded: [], failed: [], passed: [], pending: [] }

      throw e
    }
  }

  private async watchChecks() {
    await this.exec(
      command(
        "gh",
        "pr",
        "checks",
        this.number,
        "--repo",
        this.state.repo,
        "--watch",
        "--required",
      ),
      { signal: this.context.abort },
    )
  }
}
