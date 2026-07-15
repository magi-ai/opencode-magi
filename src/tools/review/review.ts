import type { ToolContext } from "@opencode-ai/plugin"
import type { Octokit } from "octokit"
import type { PullRequestVerdict } from "."
import type { Config } from "@/config"
import type { Graphql } from "@/graphql"
import type { AgentState, Event, Magi, ReviewerState, State } from "@/magi"
import type { DeepPartial, Exec } from "@/utils"
import { join } from "node:path"
import { MagiError } from "@/magi"
import { createExecWithGitHubApiRetry, quote } from "@/utils"
import { automate, postReviews } from "./action"
import { checkCi, checkPr, classifyChecks, rerunChecks } from "./check"
import { checkExistingReviews, fetchReviewContext } from "./context"
import { createReport } from "./report"
import { reconsiderClose, review, validateFindings } from "./reviewer"

interface ReviewOptions {
  dryRun: boolean
}

export class Review {
  public state: State

  constructor(
    public number: number,
    public magi: Magi,
    public config: Config.Root,
    public context: ToolContext,
    public octokit: Octokit,
    public graphql: Graphql,
    public exec: Exec,
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
  ): Promise<Review> {
    const { exec, graphql, octokit, ...rest } = await this.setup(
      number,
      magi,
      config,
      context,
    )
    const state = await magi.createState(
      join(config.review.output, number.toString()),
      { ...options, ...rest, command: "review" },
    )

    await magi.updateEvent(state.output, `Started reviewing.`)

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

  protected static async setup(
    number: number,
    magi: Magi,
    config: Config.Root,
    context: ToolContext,
  ): Promise<{
    exec: Exec
    graphql: Graphql
    octokit: Octokit
    operator: AgentState
    pr: { number: number; url: string }
    repo: string
    reviewers: { [key: string]: ReviewerState }
    sessionId: string
  }> {
    const url = `${config.github.url}/pull/${number}`
    const octokit = await magi.createOctokit(config, context.abort)
    const graphql = magi.createGraphql(octokit)
    const reviewers = Object.fromEntries(
      config.review.reviewers!.map(
        ({ account, id, model, permissions }) =>
          [id, { account, model, permissions }] as const,
      ),
    )
    const operator = config.review.operator
      ? config.review.reviewers!.find(
          ({ id }) => id === config.review.operator,
        )!
      : config.review.reviewers![
          Math.abs(number) % config.review.reviewers!.length
        ]!
    const exec = createExecWithGitHubApiRetry(
      magi.exec,
      config.github.retryApiAttempts,
    )

    return {
      exec,
      graphql,
      octokit,
      operator,
      pr: { number, url },
      repo: quote(`${config.github.owner}/${config.github.repo}`),
      reviewers,
      sessionId: context.sessionID,
    }
  }

  public checkPr = checkPr
  public checkExistingReviews = checkExistingReviews
  public checkCi = checkCi
  public classifyChecks = classifyChecks
  public rerunChecks = rerunChecks
  public fetchReviewContext = fetchReviewContext
  public review = review
  public validateFindings = validateFindings
  public reconsiderClose = reconsiderClose
  public postReviews = postReviews
  public automate = automate
  public createReport = createReport

  public async cleanup(): Promise<void> {
    if (
      this.context.abort.aborted &&
      ["preparing", "running"].includes(this.state.status)
    )
      await this.updateState({
        completedAt: new Date().toISOString(),
        status: "cancelled",
      })

    if (this.state.worktree?.path)
      await this.magi.deleteWorktree(this.state.worktree.path)
  }

  public async updateState(next: DeepPartial<State>): Promise<void> {
    this.state = await this.magi.updateState(this.state.output, next)
  }

  public async updateEvent(message: string): Promise<void> {
    await this.magi.updateEvent(this.state.output, message)
  }

  public async getEvents(): Promise<Event[]> {
    return await this.magi.getEvents(this.state.output)
  }

  public async createAgentFile(
    phase: string,
    id: string,
    content: string,
    attempt?: number,
    cycle?: number,
  ): Promise<void> {
    await this.magi.createAgentFile(
      this.state.output,
      phase,
      id,
      content,
      attempt,
      cycle,
    )
  }

  public async createSessions(): Promise<void> {
    this.context.abort.throwIfAborted()

    if (!this.state.reviewers)
      throw new MagiError("blocked", "Reviewers not found.")
    if (!this.state.operator)
      throw new MagiError("blocked", "Operator not found.")

    const reviewers = Object.fromEntries(
      await Promise.all(
        Object.entries(this.state.reviewers).map(
          async ([id, { model, permissions }]) =>
            [
              id,
              {
                sessionId: await this.magi.createSession(
                  this.state.sessionId,
                  `magi review #${this.number} ${id}`,
                  { model, permissions },
                  this.context.abort,
                ),
              },
            ] as const,
        ),
      ),
    )
    const operator = {
      sessionId: await this.magi.createSession(
        this.state.sessionId,
        `magi review #${this.number} operator`,
        {
          model: this.state.operator.model,
          permissions: this.state.operator.permissions,
        },
        this.context.abort,
      ),
    }

    await this.updateState({ operator, reviewers })
  }

  public async createWorktree(): Promise<void> {
    this.context.abort.throwIfAborted()

    await this.updateEvent(`Creating worktree.`)

    const worktree = await this.magi.createWorktree(
      this.config.review.worktree,
      this.number,
      this.state.id,
      this.context.abort,
    )

    await this.updateState({ worktree })
    await this.updateEvent(`Finished creating worktree.`)
  }

  public async resolveVerdict(): Promise<PullRequestVerdict> {
    if (!this.config.review.reviewers?.length)
      throw new MagiError("blocked", "No reviewers configured.")
    if (!this.state.reviewers)
      throw new MagiError("blocked", "Reviewers not found.")

    const counts = Object.entries(this.state.reviewers).reduce(
      (prev, [id, { outputs }]) => {
        const output = outputs?.at(-1)

        if (!output)
          throw new MagiError("blocked", `No output found for reviewer ${id}.`)

        prev[output.verdict] += 1

        return prev
      },
      {
        APPROVED: 0,
        CHANGES_REQUESTED: 0,
        CLOSED: 0,
      },
    )
    const length = this.config.review.reviewers.length
    const threshold = Math.floor(length / 2) + 1
    const majority = this.config.review.merge.approvalPolicy === "majority"
    const verdict =
      counts.CLOSED >= threshold
        ? "CLOSED"
        : (!majority && counts.APPROVED === length) ||
            (majority && counts.APPROVED >= threshold)
          ? "APPROVED"
          : "CHANGES_REQUESTED"

    await this.updateState({ pr: { verdict } })
    await this.updateEvent(`Final verdict is ${verdict}.`)

    return verdict
  }
}
