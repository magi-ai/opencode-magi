import type { ToolContext } from "@opencode-ai/plugin"
import type { Octokit } from "octokit"
import type { Config } from "@/config"
import type { Magi, State } from "@/magi"
import type { Exec } from "@/utils"
import { join } from "node:path"
import picomatch from "picomatch"
import { MagiError } from "@/magi"
import {
  command,
  createExecWithGitHubApiRetry,
  isNumber,
  quote,
  toTitleCase,
} from "@/utils"

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

export type Metadata = Awaited<
  ReturnType<Octokit["rest"]["pulls"]["get"]>
>["data"]

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

  constructor(
    private number: number,
    private magi: Magi,
    private config: Config.Root,
    private context: ToolContext,
    private octokit: Octokit,
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

    return new Review(number, magi, config, context, octokit, exec, state)
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
      throw new MagiError("blocked", `PR is not open`)
    if (metadata.draft) throw new MagiError("blocked", `PR is a draft`)

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
