import type { Config } from "@/config"
import type { Tool } from "@/magi"
import type { PullRequestVerdict } from "@/tools/review"
import { tool } from "@opencode-ai/plugin"
import { parsePrs, split, Worker } from "@/utils"
import { Merge } from "./merge"

export type * from "./index.type"

async function editCycle(
  run: Merge,
  { conflict, cycle }: { conflict?: boolean; cycle?: number } = {},
): Promise<PullRequestVerdict> {
  if (!run.state.editor?.sessionId) await run.createSession()
  if (!run.state.worktree) await run.createWorktree()

  const reviewers = Object.entries(run.state.reviewers ?? {})
  const hasSessions =
    reviewers.length && reviewers.every(([_, { sessionId }]) => sessionId)
  const edited = cycle === 1 && conflict ? true : await run.edit()

  if (cycle === 1 && conflict) await run.resolveConflict()
  else await run.postReplies()

  if (edited) await run.checkCi(run.config.merge.checks.wait)
  if (!hasSessions) await run.createSessions()

  if (edited) {
    await run.classifyChecks()
    await run.rerunChecks()
    await run.checkExistingReviews()
  }

  await run.fetchMergeContext()

  if (!edited) await run.markRepliedReviewers()

  await run.review()
  await run.validateFindings()
  await run.reconsiderClose()

  const verdict = await run.resolveVerdict()

  await run.postReviews()

  return verdict
}

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

  return { config, dryRun }
}

export const merge: Tool = function (magi) {
  return {
    magi_merge: tool({
      args: {
        dryRun: tool.schema.boolean().optional(),
        prs: tool.schema.string(),
      },
      description: "Review, fix, and merge one or more pull requests.",
      async execute(args, context) {
        const prs = parsePrs(args.prs)
        const { config, dryRun } = overrideConfig(
          await magi.getConfig({ editor: true, reviewers: true }),
          split(args.prs),
          args.dryRun,
        )
        const worker = new Worker<{ error: boolean; report: string }>(
          config.review.concurrency.runs,
        )
        const reports = await Promise.all(
          prs.map(async (pr) => {
            context.abort.throwIfAborted()

            return worker.run(async () => {
              const run = await Merge.init(pr, magi, config, context, {
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

                const verdict = await run.resolveVerdict()

                if (!skip) await run.postReviews()

                if (verdict === "CHANGES_REQUESTED")
                  await run.editCycles(async () => editCycle(run))

                const automation = await run.automate()

                if (
                  automation === "CONFLICT" &&
                  run.config.merge.automation.conflict
                ) {
                  await run.editCycles(async (cycle) =>
                    editCycle(run, { conflict: true, cycle }),
                  )
                  await run.automate()
                }

                return { error: false, report: await run.createReport() }
              } catch (e) {
                return { error: true, report: await run.createReport(e) }
              } finally {
                await run.cleanup()
              }
            })
          }),
        )
        const errors = reports.filter(({ error }) => error)

        if (errors.length)
          throw new Error(errors.map(({ report }) => report).join("\n\n"))

        return reports.map(({ report }) => report).join("\n\n")
      },
    }),
  }
}
