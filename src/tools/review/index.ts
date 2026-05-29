import type { Config } from "@/config"
import type { State, Tool } from "@/magi"
import { tool } from "@opencode-ai/plugin"
import { parsePrs } from "@/github"
import { split, Worker } from "@/utils"
import { Review } from "./review"

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

  return { config, dryRun, sync }
}

export const review: Tool = function (magi) {
  return {
    magi_review: tool({
      args: {
        dryRun: tool.schema.boolean().optional(),
        prs: tool.schema.string(),
        sync: tool.schema.boolean().optional(),
      },
      description:
        "Start background Magi review runs for one or more GitHub pull requests and post the reviews. After starting, monitor progress yourself when useful; do not tell users to call follow-up tools by name.",
      async execute(args, context) {
        const prs = parsePrs(args.prs)
        const { config, dryRun, sync } = overrideConfig(
          await magi.getConfig({ reviewers: true }),
          split(args.prs),
          args.dryRun,
          args.sync,
        )
        const run = new Review(magi, config, context, { dryRun })
        const worker = new Worker<State>(config.review.concurrency.runs)
        const states: State[] = []
        const tasks: Promise<State>[] = []

        for (const pr of prs) {
          context.abort.throwIfAborted()

          const state = await run.createState(pr)

          states.push(state)

          const task = worker.run(async () => {
            try {
              await magi.updateState(
                state.output,
                {
                  phase: "checking CI",
                  status: "running",
                },
                `Checking CI for ${run.createLink(state)}.`,
              )

              const checks = await run.checkCi(pr)

              await magi.updateState(
                state.output,
                { checks },
                `Finished checking CI for ${run.createLink(state)}.`,
              )

              return magi.updateState(
                state.output,
                {
                  completedAt: new Date().toISOString(),
                  status: "completed",
                },
                `Finished reviewing ${run.createLink(state)}.`,
              )
            } catch (e) {
              const error = e instanceof Error ? e.message : String(e)

              return magi.updateState(
                state.output,
                {
                  error,
                  status: context.abort.aborted ? "cancelled" : "failed",
                },
                `Failed reviewing ${run.createLink(state)}: ${error}`,
              )
            }
          })

          tasks.push(task)

          if (!sync) void task.catch(() => undefined)
        }

        if (sync) {
          const results = await Promise.all(tasks)
          const output = results
            .map((state) => {
              if (state.status === "completed") {
                return `Finished reviewing ${run.createLink(state)}.`
              } else {
                return `Failed reviewing ${run.createLink(state)}${state.error ? `: ${state.error}` : "."}`
              }
            })
            .join("\n")

          if (results.some(({ status }) => status !== "completed"))
            throw new Error(output)

          return output
        } else {
          return states
            .map((state) => `Started reviewing ${run.createLink(state)}.`)
            .join("\n")
        }
      },
    }),
  }
}
