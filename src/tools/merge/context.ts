import type { Merge } from "./merge"
import type {
  PullRequestReviewMarker,
  PullRequestReviewThread,
} from "@/tools/review"
import { MagiError } from "@/magi"
import {
  getClosingIssues,
  getComments,
  getInlineCommentTargets,
  getReviewThreads,
} from "@/tools/review/context"
import { marker } from "@/utils"

export async function fetchMergeContext(this: Merge): Promise<void> {
  this.context.abort.throwIfAborted()

  const output = this.state.editor?.outputs?.at(-1)

  if (!output) throw new MagiError("blocked", "Editor output not found.")

  this.state = await this.magi.updateState(this.state.output, {
    text: `Fetching merge context for ${this.getLink()}.`,
  })

  const [comments, issues, threads] = await Promise.all([
    getComments.call(this),
    getClosingIssues.call(this),
    getReviewThreads.call(this),
  ])
  const inlineCommentTargets = await getInlineCommentTargets.call(this)

  this.state = await this.magi.updateState(this.state.output, {
    pr: {
      comments,
      inlineCommentTargets,
      issues,
      threads: this.state.dryRun
        ? addSyntheticReplies.call(this, [
            ...createSyntheticThreads.call(this),
            ...threads,
          ])
        : threads,
    },
    text: `Finished fetching merge context for ${this.getLink()}.`,
  })
}

export async function markRepliedReviewers(this: Merge): Promise<void> {
  this.context.abort.throwIfAborted()

  this.state = await this.magi.updateState(this.state.output, {
    text: `Marking replied reviewers for ${this.getLink()}.`,
  })

  const output = this.state.editor?.outputs?.at(-1)

  if (!output) throw new MagiError("blocked", "Editor output not found.")
  if (!this.state.pr?.threads)
    throw new MagiError("blocked", "PR threads not found.")
  if (!this.state.reviewers)
    throw new MagiError("blocked", "Reviewers not found.")

  const replied = output.responses.flatMap(({ commentId }) => {
    const thread = this.state.pr!.threads!.find(({ comments }) =>
      comments.some(({ databaseId }) => databaseId === commentId),
    )

    if (!thread) return []

    if (this.config.mode === "single")
      return thread.comments
        .flatMap(({ body }) => marker.parse<PullRequestReviewMarker>(body))
        .flatMap(({ reviewer }) => (reviewer ? [reviewer] : []))

    return Object.entries(this.state.reviewers!)
      .filter(([, { account }]) =>
        thread.comments.some(({ author }) => account === author?.login),
      )
      .map(([id]) => id)
  })

  if (!replied.length)
    throw new MagiError("blocked", "No replied reviewers found.")

  const reviewers = Object.fromEntries(
    Object.keys(this.state.reviewers).map((id) => [
      id,
      { status: replied.includes(id) ? "reply" : "skip" },
    ]),
  )

  this.state = await this.magi.updateState(this.state.output, {
    reviewers,
    text: `Finished marking replied reviewers for ${this.getLink()}.`,
  })
}

function createSyntheticThreads(this: Merge): PullRequestReviewThread[] {
  const findings = Object.entries(this.state.reviewers ?? {}).flatMap(
    ([reviewer, { account, outputs }]) => {
      const output = outputs?.at(-1)

      if (output?.verdict !== "CHANGES_REQUESTED") return []

      return (output.findings ?? output.newFindings ?? []).map((finding) => ({
        ...finding,
        account,
        reviewer,
      }))
    },
  )

  return findings.map(
    ({ account, body, line, path, reviewer, state }, index) => ({
      comments: [
        {
          author: { login: account ?? reviewer },
          body: [
            body,
            marker.stringify({
              command: "review",
              reviewer,
              verdict: "CHANGES_REQUESTED",
            }),
          ].join("\n\n"),
          createdAt: new Date(0).toISOString(),
          databaseId: -(index + 1),
          url: "",
        },
      ],
      id: `dry-run:${reviewer}:${index + 1}`,
      isResolved: false,
      line,
      path,
      state,
    }),
  )
}

function addSyntheticReplies(
  this: Merge,
  threads: PullRequestReviewThread[],
): PullRequestReviewThread[] {
  const output = this.state.editor?.outputs?.at(-1)

  if (!output) throw new MagiError("blocked", "Editor output not found.")

  return threads.map((thread) => ({
    ...thread,
    comments: [
      ...thread.comments,
      ...output.responses.flatMap(({ body, commentId }, index) =>
        thread.comments.some(({ databaseId }) => databaseId === commentId)
          ? [
              {
                author: { login: this.state.editor!.account ?? "editor" },
                body,
                createdAt: new Date().toISOString(),
                databaseId: -(threads.length + index + 1),
                url: "",
              },
            ]
          : [],
      ),
    ],
  }))
}
