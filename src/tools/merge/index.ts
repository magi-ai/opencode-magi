import type { Config } from "@/config"
import type { State, Tool } from "@/magi"
import { tool } from "@opencode-ai/plugin"
import { filterEmpty, parsePrs, split, Worker } from "@/utils"
import { Merge } from "./merge"

function overrideConfig(
  config: Config.Root,
  args: string[],
  dryRun = false,
  sync = false,
) {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    const value = args[index + 1]!

    if (!arg.startsWith("--")) continue

    switch (arg) {
      case "--dry-run":
        dryRun = true
        break
      case "--sync":
        sync = true
        break
      case "--retry-api-attempts":
        config.github.retryApiAttempts = parseInt(value)
        break
      case "--language":
        config.language = value
        break
      case "--merge":
        config.merge.automation.merge = true
        break
      case "--no-merge":
        config.merge.automation.merge = false
        break
      case "--close":
        config.merge.automation.close = true
        break
      case "--no-close":
        config.merge.automation.close = false
        break
      case "--max-cycles":
        config.merge.maxThreadResolutionCycles = parseInt(value)
        break
      case "--retry-failed-jobs":
        config.review.checks.retryFailedJobs = parseInt(value)
        break
      case "--concurrency-reviewers":
        config.review.concurrency.reviewers = parseInt(value)
        break
      case "--concurrency-runs":
        config.review.concurrency.runs = parseInt(value)
        break
      case "--wait-checks":
        config.review.checks.wait = true
        break
      case "--no-wait-checks":
        config.review.checks.wait = false
        break
      case "--wait-checks-after-edit":
        config.merge.checks.wait = true
        break
      case "--no-wait-checks-after-edit":
        config.merge.checks.wait = false
        break
    }
  }

  return { config, dryRun, sync }
}

export const merge: Tool = function (magi) {
  return {
    magi_merge: tool({
      args: {
        dryRun: tool.schema.boolean().optional(),
        prs: tool.schema.string(),
        sync: tool.schema.boolean().optional(),
      },
      description:
        "Start background Magi merge runs for one or more GitHub pull requests with configured Magi agents. After starting, monitor progress yourself when useful; do not tell users to call follow-up tools by name.",
      async execute(args, context) {
        const prs = parsePrs(args.prs)
        const { config, dryRun, sync } = overrideConfig(
          await magi.getConfig({ editor: true, reviewers: true }),
          split(args.prs),
          args.dryRun,
          args.sync,
        )
        const worker = new Worker<State>(config.review.concurrency.runs)
        const states: State[] = []
        const tasks: Promise<State>[] = []

        for (const pr of prs) {
          context.abort.throwIfAborted()

          const run = await Merge.init(pr, magi, config, context, {
            dryRun,
          })

          states.push(run.state)

          const task = worker.run(async () => {
            try {
              await run.checkPr()

              const skip = await run.checkExistingReviews()

              await run.checkCi()

              if (!skip) {
                await run.createSessions()
                await run.createWorktree()
                await run.classifyChecks()
                await run.rerunChecks()
                await run.fetchReviewContext()
                await run.review()
                await run.validateFindings()
                await run.reconsiderClose()
              }

              const verdict = await run.resolveVerdict()

              if (!skip) await run.postReviews()

              if (verdict === "CHANGES_REQUESTED") {
                await run.createSession()

                if (!run.state.worktree) await run.createWorktree()

                await run.edit()
                await run.checkCi(run.config.merge.checks.wait)
                // await run.rereview()

                const _verdict = await run.resolveVerdict()
              }

              await run.automate(run.config.merge.automation)

              return await run.createReport()
            } catch (e) {
              return await run.createReport(e)
            } finally {
              await run.cleanup()
            }
          })

          tasks.push(task)

          if (!sync) void task
        }

        if (sync) {
          const results = await Promise.all(tasks)
          const output = filterEmpty(results.map(({ text }) => text)).join(
            "\n\n",
          )

          if (
            results.some(
              ({ status }) => status === "failed" || status === "cancelled",
            )
          )
            throw new Error(output)

          return output
        } else {
          return filterEmpty(states.map(({ text }) => text)).join("\n")
        }
      },
    }),
  }
}
