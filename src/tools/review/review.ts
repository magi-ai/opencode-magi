import type { ToolContext } from "@opencode-ai/plugin"
import type { Config } from "@/config"
import type { Magi, State } from "@/magi"
import type { Exec } from "@/utils"
import { join } from "node:path"
import { createExecWithGitHubApiRetry } from "@/github"
import { quote } from "@/utils"

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
  public repo: string
  private exec: Exec

  constructor(
    private magi: Magi,
    private config: Config.Root,
    private context: ToolContext,
    private options: ReviewOptions,
  ) {
    this.repo = quote(`${this.config.github.owner}/${this.config.github.repo}`)
    this.exec = createExecWithGitHubApiRetry(
      this.magi.exec,
      this.config.github.retryApiAttempts,
    )
  }

  public async createState(pr: number) {
    return this.magi.createState(
      join(this.config.review.output, pr.toString()),
      {
        command: "review",
        dryRun: this.options.dryRun,
        pr: {
          number: pr,
          url: `${this.config.github.url}/pull/${pr}`,
        },
        repo: this.repo,
        sessionId: this.context.sessionID,
      },
    )
  }

  public createLink(state: State) {
    return `[#${state.pr!.number}](${state.pr!.url})`
  }

  public async checkCi(pr: number) {
    this.context.abort.throwIfAborted()

    if (this.config.review.checks.wait) await this.watchChecks(pr)

    const checks = await this.getChecks(pr)

    return checks.reduce<Checks>(
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
  }

  private async getChecks(pr: number) {
    const fields = "name,state,bucket,link,workflow"

    try {
      const raw = await this.exec(
        `gh pr checks ${pr} --repo ${this.repo} --json ${fields} --required`,
        { signal: this.context.abort },
      )

      return JSON.parse(raw) as Check[]
    } catch (e) {
      if (/no checks reported on the '.+' branch/i.test(String(e))) return []

      throw e
    }
  }

  private async watchChecks(pr: number) {
    await this.exec(
      `gh pr checks ${pr} --repo ${this.repo} --watch --required`,
      { signal: this.context.abort },
    )
  }
}
