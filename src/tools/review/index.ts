import type { Config } from "@/config"
import type { Tool } from "@/magi"
import { tool } from "@opencode-ai/plugin"
import { parsePrs, split, Worker } from "@/utils"
import { Review } from "./review"

export type * from "./index.type"

function overrideConfig(
  config: Config.Root,
  args: string[],
  dryRun = false,
): { config: Config.Root; dryRun: boolean } {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    const value = args[index + 1]!

    if (!arg.startsWith("--")) continue

    switch (arg) {
      case "--dry-run":
        dryRun = true

        break
      case "--retry-api-attempts":
        config.github.retryApiAttempts = parseInt(value)

        break
      case "--language":
        config.language = value

        break
      case "--merge":
        config.review.automation.merge = true

        break
      case "--no-merge":
        config.review.automation.merge = false

        break
      case "--close":
        config.review.automation.close = true

        break
      case "--no-close":
        config.review.automation.close = false

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
    }
  }

  return { config, dryRun }
}

export const review: Tool = function (magi) {
  return {
    magi_review: tool({
      args: {
        dryRun: tool.schema.boolean().optional(),
        prs: tool.schema.string(),
      },
      description: "Review one or more pull requests and post the reviews.",
      async execute(args, context) {
        const prs = parsePrs(args.prs)
        const { config, dryRun } = overrideConfig(
          await magi.getConfig({ reviewers: true }),
          split(args.prs),
          args.dryRun,
        )
        const worker = new Worker<string>(config.review.concurrency.runs)
        const reports = await Promise.all(
          prs.map(async (pr) => {
            context.abort.throwIfAborted()

            return worker.run(async () => {
              const run = await Review.init(pr, magi, config, context, {
                dryRun,
              })

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

                await run.resolveVerdict()

                if (!skip) await run.postReviews()

                await run.automate()

                return await run.createReport()
              } catch (e) {
                return await run.createReport(e)
              } finally {
                await run.cleanup()
              }
            })
          }),
        )

        return reports.join("\n\n")
      },
    }),
  }
}
