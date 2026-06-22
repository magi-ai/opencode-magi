import type { Merge } from "./merge"
import type { PullRequestReviewThread } from "@/tools/review"
import { MagiError } from "@/magi"
import {
  getClosingIssues,
  getComments,
  getConflicts,
  getInlineCommentTargets,
  getReviewThreads,
} from "@/tools/review/context"
import { marker } from "@/utils"

export async function fetchMergeContext(this: Merge) {
  this.context.abort.throwIfAborted()

  if (!this.state.editor?.output)
    throw new MagiError("blocked", "Editor output not found.")

  this.state = await this.magi.updateState(this.state.output, {
    text: `Fetching merge context for ${this.getLink()}.`,
  })

  const [comments, conflicts, issues, threads] = await Promise.all([
    getComments.call(this),
    getConflicts.call(this),
    getClosingIssues.call(this),
    getReviewThreads.call(this),
  ])
  const inlineCommentTargets = await getInlineCommentTargets.call(
    this,
    !!conflicts,
  )

  this.state = await this.magi.updateState(this.state.output, {
    pr: {
      comments,
      conflicts,
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

function createSyntheticThreads(this: Merge): PullRequestReviewThread[] {
  const findings = Object.entries(this.state.reviewers ?? {}).flatMap(
    ([reviewer, { account, output }]) => {
      if (output?.verdict !== "CHANGES_REQUESTED") return []

      return (output.findings ?? output.newFindings ?? []).map((finding) => ({
        ...finding,
        account,
        reviewer,
      }))
    },
  )

  return findings.map(({ account, body, line, path, reviewer }, index) => ({
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
  }))
}

function addSyntheticReplies(this: Merge, threads: PullRequestReviewThread[]) {
  return threads.map((thread) => ({
    ...thread,
    comments: [
      ...thread.comments,
      ...this.state.editor!.output!.responses.flatMap(
        ({ body, commentId }, index) =>
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
