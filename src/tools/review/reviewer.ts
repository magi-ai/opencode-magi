import type {
  FindingValidationOutput,
  PullRequestFinding,
  PullRequestReviewMarker,
  PullRequestReviewThread,
  ReviewOutput,
} from "./index.type"
import type { Review } from "./review"
import type { ReviewerState } from "@/magi"
import type { PromptTag } from "@/prompts"
import { MagiError } from "@/magi"
import { Prompt } from "@/prompts"
import {
  filterEmpty,
  marker,
  omitNullish,
  retry,
  toTitleCase,
  Worker,
} from "@/utils"

interface Finding {
  finding: PullRequestFinding
  index: number
  reviewer: string
}

export async function review(this: Review): Promise<void> {
  this.context.abort.throwIfAborted()

  await this.updateEvent(`Reviewing.`)

  if (!this.config.review.reviewers?.length)
    throw new MagiError("blocked", "No reviewers configured.")

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

          const { outputs, review, sessionId, status } =
            this.state.reviewers[id]!

          if (status === "skip") {
            await this.updateEvent(`Skipping review with reviewer ${id}.`)

            return [id, {}]
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

            const rereview = status !== "initial"
            const label = rereview ? "rereview" : "review"
            const cycle = (outputs?.length ?? 0) + 1

            await this.updateEvent(`Running ${label} with reviewer ${id}.`)

            const sha = rereview
              ? (review?.commit_id ?? this.state.pr.metadata.base.sha)
              : this.state.pr.metadata.base.sha
            const inlineCommentTargets =
              this.state.pr.inlineCommentTargets?.[sha] ?? {}
            const failedChecks = this.state.pr.checks.failed.filter(
              ({ scope }) => scope,
            )
            const unresolvedThreads = this.state.pr.threads.filter(
              ({ comments, isResolved }) => {
                if (isResolved) return false

                if (this.config.mode === "single")
                  return comments.some(({ body }) => {
                    const markers = marker.parse<PullRequestReviewMarker>(body)
                    const { reviewer } = markers[0] ?? {}

                    return reviewer === id
                  })
                else
                  return comments.some(
                    ({ author }) => author?.login === account,
                  )
              },
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

            tags.push([
              "unresolved_threads",
              JSON.stringify(unresolvedThreads, null, 2),
            ])

            if (failedChecks.length) {
              const ciFailureContext = JSON.stringify(failedChecks, null, 2)

              tags.push(["ci_failure", ciFailureContext])
            }

            if (persona) tags.push(["persona", persona])

            const prompt = await Prompt.init(
              this.magi,
              this.config,
              `review/${rereview ? "rereview" : "review"}`,
            )
            const taskMessage = await prompt.create(
              !rereview
                ? this.config.review.prompts?.review
                : this.config.review.prompts?.rereview,
              tags,
              omitNullish({
                baseSha: this.state.pr.metadata.base.sha,
                headSha: this.state.pr.metadata.head.sha,
                owner: this.config.github.owner,
                pr: this.number.toString(),
                previousHeadSha: rereview
                  ? (review?.commit_id ?? this.state.pr.metadata.head.sha)
                  : undefined,
                repo: this.config.github.repo,
                worktreePath: this.state.worktree.path,
              }),
            )
            const output = await retry<ReviewOutput>(
              async (count, e) => {
                const raw = await this.magi.promptSession(
                  sessionId,
                  count === 1 ? taskMessage : await prompt.repair(e),
                  this.context.abort,
                )

                await this.createAgentFile(
                  rereview ? "rereview" : "review",
                  id,
                  raw,
                  count,
                  cycle,
                )

                const parsed = prompt.parse(raw)

                if (!prompt.validate<ReviewOutput>(parsed))
                  throw new Error(`Invalid output for reviewer ${id}.`)

                validateThreadTargets(parsed, unresolvedThreads)
                validateInlineCommentTargets(
                  status,
                  parsed,
                  inlineCommentTargets,
                )

                const findings = parsed.findings ?? parsed.newFindings ?? []

                await this.updateEvent(
                  filterEmpty([
                    `Finished ${label} with reviewer ${id}.`,
                    `Verdict: ${toTitleCase(parsed.verdict.toLocaleLowerCase())}.`,
                    parsed.comment ? `Comment:\n${parsed.comment}` : undefined,
                    findings.length
                      ? `Findings:\n${findings
                          .map(
                            ({ body, line, path, startLine }) =>
                              `- ${path}:${startLine != null ? `${startLine}-` : ""}${line}: ${body}`,
                          )
                          .join("\n")}`
                      : undefined,
                    parsed.followUps?.length
                      ? `FollowUps:\n${parsed.followUps
                          .map(
                            ({ body, commentId }) =>
                              `- Comment ${commentId}: ${body}`,
                          )
                          .join("\n")}`
                      : undefined,
                    parsed.resolves?.length
                      ? `Resolved threads:\n${parsed.resolves
                          .map(
                            ({ commentId, threadId }) =>
                              `- Comment ${commentId} in thread ${threadId}`,
                          )
                          .join("\n")}`
                      : undefined,
                  ]).join("\n\n"),
                )

                return parsed
              },
              {
                error: async (e, count) => {
                  if (e instanceof MagiError) throw e

                  await this.updateEvent(
                    `Attempt ${count} failed to ${label} with reviewer ${id}. Retrying...`,
                  )
                },
                retries: this.config.output.repairAttempts,
                signal: this.context.abort,
              },
            )

            if (!output)
              throw new MagiError(
                "blocked",
                `Invalid output for reviewer ${id}.`,
              )

            output.findings = output.findings?.map((finding) => ({
              ...finding,
              state: "accepted",
            }))

            return [id, { outputs: [...(outputs ?? []), output] }]
          }
        }),
      ),
    ),
  )

  await this.updateState({ reviewers })
  await this.updateEvent(`Finished reviewing.`)
}

export async function validateFindings(this: Review): Promise<void> {
  this.context.abort.throwIfAborted()

  if (!this.config.review.reviewers?.length)
    throw new MagiError("blocked", "No reviewers configured.")
  if (!this.state.reviewers)
    throw new MagiError("blocked", "Reviewers not found.")

  const findings = Object.entries(this.state.reviewers).flatMap(
    ([reviewer, { outputs }]) => {
      const output = outputs?.at(-1)

      if (output?.verdict !== "CHANGES_REQUESTED") return []

      return (output.findings ?? output.newFindings ?? []).map(
        (finding, index) => ({ finding, index, reviewer }),
      )
    },
  )

  if (!findings.length) return

  await this.updateEvent(`Validating review findings.`)

  const accepted = await collectAcceptedFindings.call(this, findings)
  const reviewers = Object.fromEntries(
    Object.entries(this.state.reviewers ?? {}).map(([id, reviewer]) => [
      id,
      transformState(reviewer, id, accepted),
    ]),
  )

  await notifyVerdictChanges.call(
    this,
    this.state.reviewers ?? {},
    reviewers,
    "after majority finding validation",
  )

  await this.updateState({ reviewers })
  await this.updateEvent(`Finished validating review findings.`)
}

export async function reconsiderClose(this: Review): Promise<void> {
  this.context.abort.throwIfAborted()

  if (this.config.review.merge.approvalPolicy !== "unanimous") return

  if (!this.config.review.reviewers?.length)
    throw new MagiError("blocked", "No reviewers configured.")
  if (!this.state.reviewers)
    throw new MagiError("blocked", "Reviewers not found.")

  const threshold = Math.floor(this.config.review.reviewers.length / 2) + 1
  const targetReviewers = Object.entries(this.state.reviewers).filter(
    ([, { outputs }]) => outputs?.at(-1)?.verdict === "CLOSED",
  )
  const count = targetReviewers.length

  if (!count || count >= threshold) return

  await this.updateEvent(`Reconsidering close verdicts.`)

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
      targetReviewers.map(([id, { outputs, review, sessionId, status }]) =>
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

          const cycle = (outputs?.length ?? 0) + 1
          const sha =
            status === "initial"
              ? this.state.pr.metadata.base.sha
              : (review?.commit_id ?? this.state.pr.metadata.base.sha)
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

          await this.updateEvent(
            `Reconsidering close verdict with reviewer ${id}.`,
          )

          const output = await retry<ReviewOutput>(
            async (count, e) => {
              const raw = await this.magi.promptSession(
                sessionId,
                count === 1 ? taskMessage : await prompt.repair(e),
                this.context.abort,
              )

              await this.createAgentFile(
                "close-reconsideration",
                id,
                raw,
                count,
                cycle,
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
              error: async (e, count) => {
                if (e instanceof MagiError) throw e

                await this.updateEvent(
                  `Attempt ${count} failed to reconsider close verdict with reviewer ${id}. Retrying...`,
                )
              },
              retries: this.config.output.repairAttempts,
              signal: this.context.abort,
            },
          )

          if (!output)
            throw new MagiError(
              "blocked",
              `Invalid close reconsideration output for reviewer ${id}.`,
            )

          output.findings = output.findings?.map((finding) => ({
            ...finding,
            state: "accepted",
          }))

          return [id, { outputs: [...(outputs ?? []), output] }]
        }),
      ),
    ),
  )
  const findings = Object.entries(reviewers).flatMap(
    ([reviewer, { outputs }]) => {
      const output = outputs?.at(-1)

      if (output?.verdict !== "CHANGES_REQUESTED") return []

      return (output.findings ?? []).map((finding, index) => ({
        finding,
        index,
        reviewer,
      }))
    },
  )

  await notifyVerdictChanges.call(
    this,
    this.state.reviewers ?? {},
    reviewers,
    "after close reconsideration",
  )

  const accepted = await collectAcceptedFindings.call(this, findings)
  const validatedReviewers = Object.fromEntries(
    Object.entries(reviewers).map(([id, reviewer]) => [
      id,
      transformState(reviewer, id, accepted),
    ]),
  )

  await notifyVerdictChanges.call(
    this,
    reviewers,
    validatedReviewers,
    "after majority finding validation",
  )

  await this.updateState({ reviewers: validatedReviewers })
  await this.updateEvent(`Finished reconsidering close verdicts.`)
}

async function collectAcceptedFindings(
  this: Review,
  findings: Finding[],
): Promise<Set<string>> {
  const accepted = new Set<string>()

  if (!findings.length) return accepted

  if (!this.config.review.reviewers?.length)
    throw new MagiError("blocked", "No reviewers configured.")
  if (!this.state.reviewers)
    throw new MagiError("blocked", "Reviewers not found.")

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

          await this.updateEvent(
            `Validating review findings with reviewer ${id}.`,
          )

          const targetFindings = findings.filter(
            (target) => target.reviewer !== id,
          )
          const expectedKeys = new Set(
            targetFindings.map(({ index, reviewer }) => `${reviewer}:${index}`),
          )
          const taskMessage = await prompt.create(
            this.config.review.prompts?.findingValidation,
            [
              "output_contract",
              ["findings", JSON.stringify(targetFindings, null, 2)],
            ],
            {
              owner: this.config.github.owner,
              pr: this.number.toString(),
              repo: this.config.github.repo,
            },
          )
          const output = await retry<FindingValidationOutput>(
            async (count, e) => {
              const raw = await this.magi.promptSession(
                sessionId,
                count === 1 ? taskMessage : await prompt.repair(e),
                this.context.abort,
              )

              await this.createAgentFile("finding-validation", id, raw, count)

              const parsed = prompt.parse(raw)

              if (!prompt.validate<FindingValidationOutput>(parsed))
                throw new Error(
                  `Invalid finding validation output for reviewer ${id}.`,
                )

              const seen = new Set<string>()

              for (const vote of parsed.votes) {
                if (vote.reviewer === id)
                  throw new Error(`${id} must not vote on its own findings.`)

                const key = `${vote.reviewer}:${vote.index}`

                if (!expectedKeys.has(key))
                  throw new Error(`Unexpected finding vote: ${key}.`)
                if (seen.has(key))
                  throw new Error(`Duplicate finding vote: ${key}.`)

                seen.add(key)
              }

              for (const key of expectedKeys)
                if (!seen.has(key))
                  throw new Error(`Missing finding vote: ${key}.`)

              return parsed
            },
            {
              error: async (e, count) => {
                if (e instanceof MagiError) throw e

                await this.updateEvent(
                  `Attempt ${count} failed to validate review findings with reviewer ${id}. Retrying...`,
                )
              },
              retries: this.config.output.repairAttempts,
              signal: this.context.abort,
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
    findings.map(async ({ finding, index, reviewer }) => {
      const votes = Object.entries(validations).flatMap(
        ([validator, validation]) => {
          if (validator === reviewer) return []

          const vote = validation.votes.find(
            (vote) => vote.reviewer === reviewer && vote.index === index,
          )

          return vote ? [{ validator, vote }] : []
        },
      )
      const agrees =
        1 + votes.filter(({ vote }) => vote.vote === "AGREE").length
      const key = `${reviewer}:${index}`
      const acceptedComments = votes
        .filter(({ vote }) => vote.vote === "AGREE")
        .map(({ validator, vote }) => `- ${validator}: ${vote.comment}`)
      const rejectedComments = votes
        .filter(({ vote }) => vote.vote === "DISAGREE")
        .map(({ validator, vote }) => `- ${validator}: ${vote.comment}`)

      if (agrees >= threshold) accepted.add(key)

      await this.updateEvent(
        filterEmpty([
          `Finding ${reviewer} #${index + 1} was ${agrees >= threshold ? "accepted" : "rejected"} by majority vote.`,
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

  return accepted
}

function transformState(
  reviewer: ReviewerState,
  id: string,
  accepted: Set<string>,
): ReviewerState {
  const outputs = [...(reviewer.outputs ?? [])]
  const prevOutput = outputs[outputs.length - 1]

  if (prevOutput?.verdict !== "CHANGES_REQUESTED") return reviewer

  const nextOutput: ReviewOutput = { ...prevOutput }
  const findings = (
    prevOutput.findings ??
    prevOutput.newFindings ??
    []
  ).map<PullRequestFinding>((finding, index) => ({
    ...finding,
    state: accepted.has(`${id}:${index}`) ? "accepted" : "discarded",
  }))

  if (prevOutput.findings) nextOutput.findings = findings
  else if (prevOutput.newFindings) nextOutput.newFindings = findings

  outputs[outputs.length - 1] = nextOutput

  if (!findings.some(({ state }) => state === "accepted"))
    outputs.push({ verdict: "APPROVED" })

  return { ...reviewer, outputs }
}

async function notifyVerdictChanges(
  this: Review,
  prev: { [key: string]: ReviewerState },
  next: { [key: string]: ReviewerState },
  reason: string,
): Promise<void> {
  await Promise.all(
    Object.entries(next).map(async ([id, reviewer]) => {
      const prevVerdict = prev[id]?.outputs?.at(-1)?.verdict
      const nextVerdict = reviewer.outputs?.at(-1)?.verdict

      if (!prevVerdict || !nextVerdict || prevVerdict === nextVerdict) return

      await this.updateEvent(
        `Reviewer ${id} verdict changed from ${toTitleCase(prevVerdict.toLocaleLowerCase())} to ${toTitleCase(nextVerdict.toLocaleLowerCase())} ${reason}.`,
      )
    }),
  )
}

function validateInlineCommentTargets(
  status: string | undefined,
  output: ReviewOutput,
  inlineCommentTargets: { [key: string]: number[] },
): void {
  const target = status === "initial" ? "findings" : "newFindings"
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

      for (let line = startLine; line <= finding.line; line++)
        if (!lines.includes(line))
          throw new Error(
            `${name} targets ${finding.path}:${line}, but line is not in a right-side PR diff hunk.`,
          )
    }
  }
}

function validateThreadTargets(
  { followUps, resolves }: ReviewOutput,
  threads: PullRequestReviewThread[],
): void {
  const targets = new Map(
    threads.flatMap(({ comments, id }) =>
      comments.flatMap(({ databaseId }) =>
        databaseId == null ? [] : [[databaseId, id] as const],
      ),
    ),
  )
  const allowedTargets =
    [...targets.entries()]
      .map(([commentId, threadId]) => `- ${commentId}:${threadId}`)
      .join("\n") || "none"

  if (followUps)
    for (const [index, { commentId }] of followUps.entries())
      if (!targets.has(commentId))
        throw new Error(
          `followUps[${index}].commentId must target an unresolved thread owned by the reviewer.\n\nAllowed targets:\n${allowedTargets}`,
        )

  if (resolves)
    for (const [index, { commentId, threadId }] of resolves.entries())
      if (targets.get(commentId) !== threadId)
        throw new Error(
          `resolves[${index}] must target an unresolved thread owned by the reviewer.\n\nAllowed targets:\n${allowedTargets}`,
        )
}
