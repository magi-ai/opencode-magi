import type {
  FindingValidationOutput,
  PullRequestVerdict,
  ReviewOutput,
} from "./index.type"
import type { Review } from "./review"
import type { ReviewerState } from "@/magi"
import type { PromptTag } from "@/prompts"
import { MagiError } from "@/magi"
import { Prompt } from "@/prompts"
import { filterEmpty, omitNullish, retry, Worker } from "@/utils"

export async function review(this: Review) {
  this.context.abort.throwIfAborted()

  if (!this.config.review.reviewers?.length)
    throw new MagiError("blocked", "No reviewers configured.")

  this.state = await this.magi.updateState(this.state.output, {
    text: `Reviewing ${this.getLink()}.`,
  })

  const worker = new Worker<[string, ReviewerState]>(
    this.config.review.concurrency.reviewers,
  )
  const reviewers = Object.fromEntries(
    await Promise.all(
      this.config.review.reviewers.map(({ account, id, persona }) =>
        worker.run(async () => {
          if (!this.state.pr?.metadata)
            throw new MagiError("blocked", "PR metadata not found.")
          if (!this.state.worktree)
            throw new MagiError("blocked", "PR worktree not found.")
          if (!this.state.pr.checks)
            throw new MagiError("blocked", "PR checks not found.")
          if (!this.state.pr.threads)
            throw new MagiError("blocked", "PR threads not found.")
          if (!this.state.reviewers)
            throw new MagiError("blocked", "Reviewers not found.")

          const { review, sessionId, status } = this.state.reviewers[id]!

          if (status === "skip") {
            if (!review)
              throw new MagiError(
                "blocked",
                `No review found for reviewer ${id}.`,
              )

            const verdict = review.state as PullRequestVerdict

            this.magi.notify(
              this.state.sessionId,
              `Skipping review for ${this.getLink()} with reviewer ${id}.`,
            )

            return [id, { output: { verdict } }]
          } else {
            if (!sessionId)
              throw new MagiError(
                "blocked",
                `No session ID found for reviewer ${id}.`,
              )
            if (status === "rereview" && !review?.commit_id)
              throw new MagiError(
                "blocked",
                `Missing previous review commit for reviewer ${id}.`,
              )

            const label = `${status === "rereview" ? "re" : ""}review`

            await this.magi.notify(
              this.state.sessionId,
              `Running ${label} for ${this.getLink()} with reviewer ${id}.`,
            )

            const sha =
              status === "initial"
                ? this.state.pr.metadata.base.sha
                : review!.commit_id!
            const inlineCommentTargets =
              this.state.pr.inlineCommentTargets?.[sha] ?? {}
            const failedChecks = this.state.pr.checks.failed.filter(
              ({ scope }) => scope,
            )
            const unresolvedThreads = this.state.pr.threads.filter(
              ({ comments, isResolved }) =>
                !isResolved &&
                (!account ||
                  comments.some(({ author }) => author?.login === account)),
            )
            const reviewContext = JSON.stringify(
              omitNullish({
                checks: this.state.pr.checks,
                comments: this.state.pr.comments,
                files: this.state.pr.files,
                issues: this.state.pr.issues,
                metadata: this.state.pr.metadata,
                threads: this.state.pr.threads,
              }),
              null,
              2,
            )
            const tags: PromptTag[] = [
              "output_contract",
              ["review", reviewContext],
            ]

            if (review) {
              const previousReviewContext = JSON.stringify(
                omitNullish({
                  body: review.body || undefined,
                  commitId: review.commit_id,
                  state: review.state,
                  submittedAt: review.submitted_at,
                }),
                null,
                2,
              )

              tags.push(["previous_review", previousReviewContext])
            }

            if (unresolvedThreads.length) {
              const unresolvedThreadsContext = JSON.stringify(
                unresolvedThreads,
                null,
                2,
              )

              tags.push(["unresolved_threads", unresolvedThreadsContext])
            }

            if (this.state.pr.conflicts) {
              const mergeConflictContext = JSON.stringify(
                this.state.pr.conflicts,
                null,
                2,
              )

              tags.push(["merge_conflict", mergeConflictContext])
            }

            if (failedChecks.length) {
              const ciFailureContext = JSON.stringify(failedChecks, null, 2)

              tags.push(["ci_failure", ciFailureContext])
            }

            if (persona) tags.push(["persona", persona])

            const prompt = await Prompt.init(
              this.magi,
              this.config,
              `review/${status === "rereview" ? "rereview" : "review"}`,
            )
            const taskMessage = await prompt.create(
              status === "rereview"
                ? this.config.review.prompts?.rereview
                : this.config.review.prompts?.review,
              tags,
              omitNullish({
                baseSha: this.state.pr.metadata.base.sha,
                headSha: this.state.pr.metadata.head.sha,
                owner: this.config.github.owner,
                pr: this.number.toString(),
                previousHeadSha: review?.commit_id,
                repo: this.config.github.repo,
                worktreePath: this.state.worktree.path,
              }),
            )
            const repairMessage = await prompt.repair()
            const output = await retry<ReviewOutput>(
              async (count) => {
                const raw = await this.magi.promptSession(
                  sessionId,
                  count === 1 ? taskMessage : repairMessage,
                )
                const parsed = prompt.parse(raw)

                if (!prompt.validate<ReviewOutput>(parsed))
                  throw new Error(`Invalid output for reviewer ${id}.`)

                validateInlineCommentTargets(
                  status,
                  parsed,
                  inlineCommentTargets,
                )

                return parsed
              },
              {
                error: (_, count) =>
                  this.magi.notify(
                    this.state.sessionId,
                    `Attempt ${count} failed to ${label} for ${this.getLink()} with reviewer ${id}. Retrying...`,
                  ),
                retries: this.config.output.repairAttempts,
              },
            )

            if (!output)
              throw new MagiError(
                "blocked",
                `Invalid output for reviewer ${id}.`,
              )

            return [id, { output }]
          }
        }),
      ),
    ),
  )

  this.state = await this.magi.updateState(this.state.output, {
    reviewers,
    text: `Finished reviewing ${this.getLink()}.`,
  })
}

export async function validateFindings(this: Review) {
  this.context.abort.throwIfAborted()

  if (!this.config.review.reviewers?.length)
    throw new MagiError("blocked", "No reviewers configured.")
  if (!this.state.reviewers)
    throw new MagiError("blocked", "Reviewers not found.")

  const targets = Object.entries(this.state.reviewers).flatMap(
    ([reviewer, { output }]) => {
      if (output?.verdict !== "CHANGES_REQUESTED") return []

      return (output.findings ?? output.newFindings ?? []).map(
        (finding, findingIndex) => ({ finding, findingIndex, reviewer }),
      )
    },
  )

  if (!targets.length) return

  this.state = await this.magi.updateState(this.state.output, {
    text: `Validating review findings for ${this.getLink()}.`,
  })

  const worker = new Worker<[string, FindingValidationOutput]>(
    this.config.review.concurrency.reviewers,
  )
  const prompt = await Prompt.init(
    this.magi,
    this.config,
    "review/finding-validation",
  )
  const validations = Object.fromEntries(
    await Promise.all(
      this.config.review.reviewers.map(({ id }) =>
        worker.run(async () => {
          const { sessionId } = this.state.reviewers![id]!

          if (!sessionId)
            throw new MagiError(
              "blocked",
              `No session ID found for reviewer ${id}.`,
            )

          await this.magi.notify(
            this.state.sessionId,
            `Validating review findings for ${this.getLink()} with reviewer ${id}.`,
          )

          const reviewTargets = targets.filter(
            (target) => target.reviewer !== id,
          )
          const taskMessage = await prompt.create(
            this.config.review.prompts?.findingValidation,
            ["output_contract"],
            {
              findings: JSON.stringify(reviewTargets, null, 2),
              owner: this.config.github.owner,
              pr: this.number.toString(),
              repo: this.config.github.repo,
            },
          )
          const repairMessage = await prompt.repair()
          const output = await retry<FindingValidationOutput>(
            async (count) => {
              const raw = await this.magi.promptSession(
                sessionId,
                count === 1 ? taskMessage : repairMessage,
              )
              const parsed = prompt.parse(raw)

              if (!prompt.validate<FindingValidationOutput>(parsed))
                throw new Error(
                  `Invalid finding validation output for reviewer ${id}.`,
                )

              const expected = targets.filter(({ reviewer }) => reviewer !== id)
              const expectedKeys = new Set(
                expected.map(
                  ({ findingIndex, reviewer }) => `${reviewer}:${findingIndex}`,
                ),
              )
              const seen = new Set<string>()

              for (const vote of parsed.votes) {
                if (vote.reviewer === id)
                  throw new Error(`${id} must not vote on its own findings.`)

                const key = `${vote.reviewer}:${vote.findingIndex}`

                if (!expectedKeys.has(key))
                  throw new Error(`Unexpected finding vote: ${key}.`)
                if (seen.has(key))
                  throw new Error(`Duplicate finding vote: ${key}.`)

                seen.add(key)
              }

              for (const target of expected) {
                const key = `${target.reviewer}:${target.findingIndex}`

                if (!seen.has(key))
                  throw new Error(`Missing finding vote: ${key}.`)
              }

              return parsed
            },
            {
              error: (_, count) =>
                this.magi.notify(
                  this.state.sessionId,
                  `Attempt ${count} failed to validate review findings for ${this.getLink()} with reviewer ${id}. Retrying...`,
                ),
              retries: this.config.output.repairAttempts,
            },
          )

          if (!output)
            throw new MagiError(
              "blocked",
              `Invalid finding validation output for reviewer ${id}.`,
            )

          return [id, output]
        }),
      ),
    ),
  )
  const threshold = Math.floor(this.config.review.reviewers.length / 2) + 1

  await Promise.all(
    targets.map(async ({ finding, findingIndex, reviewer }) => {
      const votes = Object.entries(validations).flatMap(
        ([validator, validation]) => {
          if (validator === reviewer) return []

          const vote = validation.votes.find(
            (vote) =>
              vote.reviewer === reviewer && vote.findingIndex === findingIndex,
          )

          return vote ? [{ validator, vote }] : []
        },
      )
      const agrees =
        1 + votes.filter(({ vote }) => vote.vote === "AGREE").length
      const accepted = agrees >= threshold
      const acceptedComments = votes
        .filter(({ vote }) => vote.vote === "AGREE")
        .map(({ validator, vote }) => `- ${validator}: ${vote.comment}`)
      const rejectedComments = votes
        .filter(({ vote }) => vote.vote === "DISAGREE")
        .map(({ validator, vote }) => `- ${validator}: ${vote.comment}`)

      await this.magi.notify(
        this.state.sessionId,
        filterEmpty([
          `Finding ${reviewer} #${findingIndex + 1} for ${this.getLink()} was ${accepted ? "accepted" : "rejected"} by majority vote.`,
          `Finding: ${finding.path}:${finding.line}\n${finding.body}`,
          acceptedComments.length
            ? `Accepted by:\n${acceptedComments.join("\n")}`
            : undefined,
          rejectedComments.length
            ? `Rejected by:\n${rejectedComments.join("\n")}`
            : undefined,
        ]).join("\n\n"),
      )
    }),
  )

  const reviewers = Object.fromEntries(
    Object.entries(this.state.reviewers ?? {}).map(([id, reviewer]) => {
      const output = reviewer.output

      if (output?.verdict !== "CHANGES_REQUESTED") return [id, { output }]

      const keptIndexes = new Set<number>()
      const findings = output.findings ?? output.newFindings ?? []

      findings.forEach((_finding, findingIndex) => {
        let agrees = 1

        for (const [validator, validation] of Object.entries(validations)) {
          if (validator === id) continue

          const vote = validation.votes.find(
            (vote) =>
              vote.reviewer === id && vote.findingIndex === findingIndex,
          )

          if (vote?.vote === "AGREE") agrees += 1
        }

        if (agrees >= threshold) keptIndexes.add(findingIndex)
      })

      if (output.findings) {
        const findings = output.findings.filter((_finding, index) =>
          keptIndexes.has(index),
        )
        const newOutput = findings.length
          ? { ...output, findings }
          : { ...output, findings: [], verdict: "APPROVED" }

        return [id, { output: newOutput }]
      } else {
        const newFindings = output.newFindings?.filter((_finding, index) =>
          keptIndexes.has(index),
        )
        const newOutput =
          newFindings?.length || output.followUps?.length
            ? { ...output, newFindings }
            : { ...output, newFindings: [], verdict: "APPROVED" }

        return [id, { output: newOutput }]
      }
    }),
  )

  this.state = await this.magi.updateState(this.state.output, {
    reviewers,
    text: `Finished validating review findings for ${this.getLink()}.`,
  })
}

export async function reconsiderClose(this: Review) {
  this.context.abort.throwIfAborted()

  if (this.config.review.merge.approvalPolicy !== "unanimous") return

  if (!this.config.review.reviewers?.length)
    throw new MagiError("blocked", "No reviewers configured.")
  if (!this.state.reviewers)
    throw new MagiError("blocked", "Reviewers not found.")

  const threshold = Math.floor(this.config.review.reviewers.length / 2) + 1
  const targetReviewers = Object.entries(this.state.reviewers).filter(
    ([, { output }]) => output?.verdict === "CLOSED",
  )
  const count = targetReviewers.length

  if (!count || count >= threshold) return

  this.state = await this.magi.updateState(this.state.output, {
    text: `Reconsidering close verdicts for ${this.getLink()}.`,
  })

  const worker = new Worker<[string, ReviewerState]>(
    this.config.review.concurrency.reviewers,
  )
  const prompt = await Prompt.init(
    this.magi,
    this.config,
    "review/close-reconsideration",
  )
  const reviewers = Object.fromEntries(
    await Promise.all(
      targetReviewers.map(([id, { review, sessionId, status }]) =>
        worker.run(async () => {
          if (!this.state.pr?.metadata)
            throw new MagiError("blocked", "PR metadata not found.")
          if (!sessionId)
            throw new MagiError(
              "blocked",
              `No session ID found for reviewer ${id}.`,
            )
          if (status === "rereview" && !review?.commit_id)
            throw new MagiError(
              "blocked",
              `Missing previous review commit for reviewer ${id}.`,
            )

          const sha =
            status === "initial"
              ? this.state.pr.metadata.base.sha
              : review!.commit_id!
          const inlineCommentTargets =
            this.state.pr.inlineCommentTargets?.[sha] ?? {}
          const taskMessage = await prompt.create(
            this.config.review.prompts?.closeReconsideration,
            ["output_contract"],
            {
              owner: this.config.github.owner,
              pr: this.number.toString(),
              repo: this.config.github.repo,
            },
          )
          const repairMessage = await prompt.repair()

          await this.magi.notify(
            this.state.sessionId,
            `Reconsidering close verdict for ${this.getLink()} with reviewer ${id}.`,
          )

          const output = await retry<ReviewOutput>(
            async (count) => {
              const raw = await this.magi.promptSession(
                sessionId,
                count === 1 ? taskMessage : repairMessage,
              )
              const parsed = prompt.parse(raw)

              if (!prompt.validate<ReviewOutput>(parsed))
                throw new Error(
                  `Invalid close reconsideration output for reviewer ${id}.`,
                )

              validateInlineCommentTargets(
                "initial",
                parsed,
                inlineCommentTargets,
              )

              return parsed
            },
            {
              error: (_, count) =>
                this.magi.notify(
                  this.state.sessionId,
                  `Attempt ${count} failed to reconsider close verdict for ${this.getLink()} with reviewer ${id}. Retrying...`,
                ),
              retries: this.config.output.repairAttempts,
            },
          )

          if (!output)
            throw new MagiError(
              "blocked",
              `Invalid close reconsideration output for reviewer ${id}.`,
            )

          return [
            id,
            {
              output: {
                comment: output.comment,
                findings: output.findings,
                followUps: undefined,
                newFindings: undefined,
                resolves: undefined,
                verdict: output.verdict,
              },
            },
          ]
        }),
      ),
    ),
  )

  this.state = await this.magi.updateState(this.state.output, {
    reviewers,
    text: `Finished reconsidering close verdicts for ${this.getLink()}.`,
  })
}

function validateInlineCommentTargets(
  status: string | undefined,
  output: ReviewOutput,
  inlineCommentTargets: { [key: string]: number[] },
) {
  const target = status === "rereview" ? "newFindings" : "findings"
  const findings = output[target] ?? []

  for (const [index, finding] of findings.entries()) {
    const name = `${target}[${index}]`

    if (!Number.isInteger(finding.line) || finding.line < 1)
      throw new Error(`${name}.line must be a positive integer.`)

    if (finding.startLine != null) {
      if (!Number.isInteger(finding.startLine) || finding.startLine < 1)
        throw new Error(`${name}.startLine must be a positive integer.`)

      if (finding.startLine > finding.line)
        throw new Error(
          `${name}.startLine must be before or equal to ${name}.line.`,
        )
    }

    const lines = inlineCommentTargets[finding.path]

    if (!lines) {
      throw new Error(
        `${name} targets ${finding.path}:${finding.line}, but path is not in the PR diff.`,
      )
    } else {
      const startLine = finding.startLine ?? finding.line

      for (let line = startLine; line <= finding.line; line++) {
        if (!lines.includes(line))
          throw new Error(
            `${name} targets ${finding.path}:${line}, but line is not in a right-side PR diff hunk.`,
          )
      }
    }
  }
}
