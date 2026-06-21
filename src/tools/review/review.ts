import type { ToolContext } from "@opencode-ai/plugin"
import type { Octokit } from "octokit"
import type { Config } from "@/config"
import type { Graphql } from "@/graphql"
import type { Magi, State } from "@/magi"
import type { Exec } from "@/utils"
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
  ) {
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
    const state = await magi.createState(
      join(config.review.output, number.toString()),
      {
        command: "review",
        dryRun: options.dryRun,
        operator,
        pr: { number, url },
        repo: quote(`${config.github.owner}/${config.github.repo}`),
        reviewers,
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

  public async cleanup() {
    if (!this.state.worktree?.path) return

    await this.magi.deleteWorktree(this.state.worktree.path)
  }

  public getLink() {
    return `[#${this.state.pr!.number}](${this.state.pr!.url})`
  }

  public async createSessions() {
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
      ),
    }

    this.state = await this.magi.updateState(this.state.output, {
      operator,
      reviewers,
    })

    return reviewers
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

  public async resolveVerdict() {
    if (!this.config.review.reviewers?.length)
      throw new MagiError("blocked", "No reviewers configured.")
    if (!this.state.reviewers)
      throw new MagiError("blocked", "Reviewers not found.")

    const counts = { APPROVED: 0, CHANGES_REQUESTED: 0, CLOSED: 0 }
    const length = this.config.review.reviewers.length
    const threshold = Math.floor(length / 2) + 1

    for (const [id, { output }] of Object.entries(this.state.reviewers)) {
      if (!output)
        throw new MagiError("blocked", `No output found for reviewer ${id}.`)

      counts[output.verdict] += 1
    }

    const majority = this.config.review.merge.approvalPolicy === "majority"
    const verdict =
      counts.CLOSED >= threshold
        ? "CLOSED"
        : (!majority && counts.APPROVED === length) ||
            (majority && counts.APPROVED >= threshold)
          ? "APPROVED"
          : "CHANGES_REQUESTED"

    this.state = await this.magi.updateState(this.state.output, {
      pr: { verdict },
      text: `Final verdict for ${this.getLink()} is ${verdict}.`,
    })
  }
}
