import type { ToolContext } from "@opencode-ai/plugin"
import type { Config } from "@/config"
import type { Magi, State } from "@/magi"
import type { Exec } from "@/utils"
import { jsonToGraphQLQuery, VariableType } from "json-to-graphql-query"
import { join } from "node:path"
import picomatch from "picomatch"
import { createExecWithGitHubApiRetry } from "@/github"
import { MagiError } from "@/magi"
import { command, isNumber, quote, toTitleCase } from "@/utils"

export interface Check {
  bucket?: string
  name: string
  state?: string
}

export interface Checks {
  excluded: Check[]
  failed: Check[]
  passed: Check[]
  pending: Check[]
}

export interface Metadata {
  author?: { login?: string }
  baseRefName: string
  baseRefOid: string
  body?: string
  changedFiles?: number
  headRefName: string
  headRefOid: string
  headRepository?: { name?: string }
  headRepositoryOwner?: { login?: string }
  isDraft: boolean
  state?: string
  title: string
  url: string
}

const ci = {
  isExcluded(exclude: string[], { name }: Check) {
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
  isFailed(check: Check) {
    return check.bucket === "fail" || check.state === "FAILURE"
  },
  isPassed(check: Check) {
    return check.bucket === "pass" || check.state === "SUCCESS"
  },
  isPending(check: Check) {
    return !this.isFailed(check) && !this.isPassed(check)
  },
}

interface ReviewOptions {
  dryRun: boolean
}

export class Review {
  public state: State
  private exec: Exec

  constructor(
    private number: number,
    private magi: Magi,
    private config: Config.Root,
    private context: ToolContext,
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

    return new Review(number, magi, config, context, state)
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

    const metadata = await this.getMetadata()

    if (metadata.isDraft) throw new MagiError("blocked", `PR is a draft`)

    if (
      this.config.review.safety.allowAuthors.length ||
      this.config.review.safety.blockedPaths.length ||
      this.config.review.safety.requiredLabels.length ||
      isNumber(this.config.review.safety.maxChangedFiles)
    ) {
      const errors: string[] = []
      const { author, changedFiles, files, labels } =
        await this.getAdditionalMetadata()

      if (this.config.review.safety.allowAuthors.length) {
        if (!this.config.review.safety.allowAuthors.includes(author))
          errors.push(`Author is not allowed: ${author}.`)
      }

      if (this.config.review.safety.blockedPaths.length) {
        const isBlocked = picomatch(this.config.review.safety.blockedPaths, {
          dot: true,
        })
        const blocked = files.filter((file) => isBlocked(file))

        if (blocked.length)
          errors.push(`Blocked paths changed: ${blocked.join(", ")}.`)
      }

      if (this.config.review.safety.requiredLabels.length) {
        const missingLabels = this.config.review.safety.requiredLabels.filter(
          (label) => !labels.includes(label),
        )

        if (missingLabels.length)
          errors.push(`Required labels missing: ${missingLabels.join(", ")}.`)
      }

      if (
        isNumber(this.config.review.safety.maxChangedFiles) &&
        changedFiles > this.config.review.safety.maxChangedFiles
      ) {
        errors.push(
          `Changed files exceed limit: ${changedFiles} > ${this.config.review.safety.maxChangedFiles}.`,
        )
      }

      if (errors.length) {
        throw new MagiError(
          "blocked",
          `PR is safety blocked. ${errors.join(" ")}`,
        )
      }
    }

    this.state = await this.magi.updateState(this.state.output, {
      pr: { metadata },
      text: `Finished checking PR ${this.getLink()}.`,
    })

    return this.state
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

    return checks
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
    const fields = [
      "title",
      "body",
      "url",
      "state",
      "author",
      "isDraft",
      "baseRefOid",
      "headRefOid",
      "baseRefName",
      "headRefName",
      "headRepository",
      "headRepositoryOwner",
      "changedFiles",
    ].join(",")
    const raw = await this.exec(
      `gh pr view ${this.number} --repo ${this.state.repo} --json ${fields}`,
      { signal: this.context.abort },
    )
    const metadata = JSON.parse(raw) as Metadata

    return metadata
  }

  private async getAdditionalMetadata() {
    const query = jsonToGraphQLQuery(
      {
        query: {
          __variables: {
            filesCursor: "String",
            owner: "String!",
            pr: "Int!",
            repo: "String!",
          },
          repository: {
            __args: {
              name: new VariableType("repo"),
              owner: new VariableType("owner"),
            },
            pullRequest: {
              __args: { number: new VariableType("pr") },
              author: { login: true },
              changedFiles: true,
              files: {
                __args: { after: new VariableType("filesCursor"), first: 100 },
                nodes: { path: true },
                pageInfo: { endCursor: true, hasNextPage: true },
              },
              labels: {
                __args: { first: 100 },
                nodes: { name: true },
              },
            },
          },
        },
      },
      { pretty: true },
    )
    const files: string[] = []

    let author = ""
    let changedFiles = 0
    let labels: string[] = []
    let cursor: string | undefined

    for (;;) {
      const raw = await this.exec(
        command(
          "gh",
          "api",
          this.config.github.host !== "github.com" &&
            `--hostname ${quote(this.config.github.host)}`,
          "graphql",
          "-f",
          `query=${quote(query)}`,
          "-F",
          `owner=${quote(this.config.github.owner!)}`,
          "-F",
          `repo=${quote(this.config.github.repo!)}`,
          "-F",
          `pr=${this.number}`,
          cursor && `-F filesCursor=${quote(cursor)}`,
        ),
        { signal: this.context.abort },
      )
      const { data } = JSON.parse(raw) as {
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
      const { pullRequest: pr } = data.repository

      author = pr.author?.login ?? author
      changedFiles = pr.changedFiles
      labels = pr.labels.nodes.map(({ name }) => name)

      files.push(...pr.files.nodes.map(({ path }) => path))

      if (!pr.files.pageInfo.hasNextPage) break

      cursor = pr.files.pageInfo.endCursor

      if (!cursor) break
    }

    return { author, changedFiles, files, labels }
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

      return (JSON.parse(raw) as Check[]).reduce<Checks>(
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
