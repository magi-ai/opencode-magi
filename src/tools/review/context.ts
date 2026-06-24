import type {
  PullRequestClosingIssue,
  PullRequestComment,
  PullRequestCommit,
  PullRequestInlineCommentTargets,
  PullRequestReview,
  PullRequestReviewMarker,
  PullRequestReviewThread,
  PullRequestVerdict,
} from "./index.type"
import type { Review } from "./review"
import type { ReviewerState } from "@/magi"
import { MagiError } from "@/magi"
import { command, filterEmpty, marker, quote } from "@/utils"

export async function checkExistingReviews(this: Review): Promise<boolean> {
  this.context.abort.throwIfAborted()

  this.state = await this.magi.updateState(this.state.output, {
    text: `Fetching existing reviews for ${this.getLink()}.`,
  })

  if (!this.state.pr?.metadata)
    throw new MagiError("blocked", "PR metadata not found.")
  if (!this.config.review.reviewers?.length)
    throw new MagiError("blocked", "No reviewers configured.")

  const [reviews, commits, threads] = await Promise.all([
    getReviews.call(this),
    getCommits.call(this),
    getReviewThreads.call(this),
  ])

  this.state = await this.magi.updateState(this.state.output, {
    pr: { commits, reviews, threads },
  })
  const latestNonMergeCommit = commits
    .toReversed()
    .find(({ parents }) => parents.length < 2)
  const reviewers: { [key: string]: ReviewerState } = Object.fromEntries(
    this.config.review.reviewers.map(({ account, id }) => {
      const targetReviews = filterEmpty(
        reviews.map((review) => {
          if (this.config.mode === "single") {
            if (review.user!.login !== this.config.account) return

            const markers = marker.parse<PullRequestReviewMarker>(review.body)
            const { body, reviewer, verdict } =
              markers.find(({ reviewer }) => reviewer === id) ?? {}

            if (reviewer !== id || !verdict) return

            try {
              return {
                ...review,
                body: body ? decodeURIComponent(body) : "",
                state: verdict,
              }
            } catch {
              return { ...review, body: "", state: verdict }
            }
          } else {
            if (review.user!.login !== account) return

            if (review.state === "APPROVED") return review
            if (review.state === "CHANGES_REQUESTED") return review
            if (review.state !== "COMMENTED") return

            const markers = marker.parse<PullRequestReviewMarker>(review.body)
            const { reviewer, verdict } = markers[0] ?? {}

            if (reviewer !== id || verdict !== "CLOSED") return

            return { ...review, state: "CLOSED" }
          }
        }),
      )

      if (!targetReviews.length) {
        return [id, { status: "initial" }]
      } else {
        const latestReviews = targetReviews.filter(
          ({ submitted_at }) =>
            latestNonMergeCommit?.commit.author?.date &&
            submitted_at &&
            submitted_at.localeCompare(
              latestNonMergeCommit.commit.author.date,
            ) >= 0,
        )
        const review = targetReviews.at(-1)

        if (latestReviews.length) return [id, { review, status: "skip" }]
        else return [id, { review, status: "rereview" }]
      }
    }),
  )

  for (const [id, reviewer] of Object.entries(reviewers)) {
    if (reviewer.status !== "skip") continue

    if (!reviewer.review)
      throw new MagiError("blocked", `No review found for reviewer ${id}.`)

    const single = this.config.mode === "single"
    const author = single ? this.config.account : reviewer.account
    const hasUserReply = threads.some(({ comments, isResolved }) => {
      if (isResolved) return false

      const belongsToReviewer = single
        ? comments.some(({ body }) =>
            marker
              .parse<PullRequestReviewMarker>(body)
              .some(({ reviewer }) => reviewer === id),
          )
        : comments.some(({ author }) => author?.login === reviewer.account)

      if (!belongsToReviewer) return false

      const last = comments.at(-1)

      return (
        !!last &&
        last.author?.login !== author &&
        (!reviewer.review?.submitted_at ||
          last.createdAt.localeCompare(reviewer.review.submitted_at) > 0)
      )
    })

    if (hasUserReply) {
      reviewer.status = "rereview"
    } else {
      const verdict = reviewer.review.state as PullRequestVerdict

      reviewer.outputs = [...(reviewer.outputs ?? []), { verdict }]
    }
  }

  const skip = Object.values(reviewers).every(({ status }) => status === "skip")

  this.state = await this.magi.updateState(this.state.output, {
    reviewers,
    text: `Finished fetching existing reviews for ${this.getLink()}.`,
  })

  return skip
}

export async function fetchReviewContext(this: Review): Promise<void> {
  this.context.abort.throwIfAborted()

  this.state = await this.magi.updateState(this.state.output, {
    text: `Fetching review context for ${this.getLink()}.`,
  })

  const [comments, issues, threads] = await Promise.all([
    getComments.call(this),
    getClosingIssues.call(this),
    getReviewThreads.call(this),
  ])
  const inlineCommentTargets = await getInlineCommentTargets.call(this)

  this.state = await this.magi.updateState(this.state.output, {
    pr: { comments, inlineCommentTargets, issues, threads },
    text: `Finished fetching review context for ${this.getLink()}.`,
  })
}

export async function getComments(this: Review): Promise<PullRequestComment[]> {
  return await this.octokit.paginate(this.octokit.rest.issues.listComments, {
    issue_number: this.number,
    owner: this.config.github.owner,
    repo: this.config.github.repo,
  })
}

async function getReviews(this: Review): Promise<PullRequestReview[]> {
  return await this.octokit.paginate(this.octokit.rest.pulls.listReviews, {
    owner: this.config.github.owner,
    pull_number: this.number,
    repo: this.config.github.repo,
  })
}

async function getCommits(this: Review): Promise<PullRequestCommit[]> {
  return await this.octokit.paginate(this.octokit.rest.pulls.listCommits, {
    owner: this.config.github.owner,
    pull_number: this.number,
    repo: this.config.github.repo,
  })
}

export async function getClosingIssues(
  this: Review,
): Promise<PullRequestClosingIssue[]> {
  const data = await this.graphql.paginate(this.graphql.closingIssues, {
    owner: this.config.github.owner,
    pr: this.number,
    repo: this.config.github.repo,
  })

  return filterEmpty(
    data.repository?.pullRequest?.closingIssuesReferences?.nodes?.map(
      (node) =>
        node && { ...node, comments: filterEmpty(node.comments.nodes ?? []) },
    ) ?? [],
  )
}

export async function getReviewThreads(
  this: Review,
): Promise<PullRequestReviewThread[]> {
  const data = await this.graphql.paginate(this.graphql.reviewThreads, {
    owner: this.config.github.owner,
    pr: this.number,
    repo: this.config.github.repo,
  })

  return filterEmpty(
    data.repository?.pullRequest?.reviewThreads.nodes?.map(
      (node) =>
        node && { ...node, comments: filterEmpty(node.comments.nodes ?? []) },
    ) ?? [],
  )
}

export async function getInlineCommentTargets(
  this: Review,
): Promise<PullRequestInlineCommentTargets> {
  if (!this.state.reviewers)
    throw new MagiError("blocked", "Reviewers not found.")
  if (!this.state.pr?.metadata)
    throw new MagiError("blocked", "PR metadata not found.")
  if (!this.state.worktree)
    throw new MagiError("blocked", "PR worktree not found.")

  const get = async (
    from: [string, string],
    to: [string, string],
  ): Promise<{ [key: string]: number[] }> => {
    const inlineCommentTargets: { [key: string]: number[] } = {}
    const [fromSource, fromSha] = from
    const [toSource, toSha] = to
    const commits = [
      { label: "from", sha: fromSha, source: fromSource },
      { label: "to", sha: toSha, source: toSource },
    ]
    const missing = filterEmpty(
      await Promise.all(
        commits.map(async (commit) => {
          if (!(await hasCommit.call(this, commit.sha))) return commit
        }),
      ),
    )
    const sources = new Set(missing.map(({ source }) => source))

    for (const source of sources) {
      const ref =
        source === "base"
          ? this.state.pr!.metadata!.base.ref
          : this.state.pr!.metadata!.head.ref
      const url =
        source === "base"
          ? this.state.pr!.metadata!.base.repo.clone_url
          : this.state.pr!.metadata!.head.repo.clone_url

      await this.exec(
        command(
          "git",
          "fetch",
          "--no-tags",
          quote(url),
          quote(`refs/heads/${ref}`),
        ),
        { cwd: this.state.worktree!.path, signal: this.context.abort },
      )
    }

    for (const commit of missing) {
      if (await hasCommit.call(this, commit.sha)) continue

      const ref =
        commit.source === "base"
          ? this.state.pr!.metadata!.base.ref
          : this.state.pr!.metadata!.head.ref

      throw new MagiError(
        "blocked",
        `${commit.label} commit ${commit.sha} is unavailable after fetching ${commit.source} ref ${ref}.`,
      )
    }

    const diff = await this.exec(
      command(
        "git",
        "diff",
        "--no-ext-diff",
        "--unified=3",
        quote(`${fromSha}...${toSha}`),
      ),
      { cwd: this.state.worktree!.path, signal: this.context.abort },
    )

    let path: string | undefined
    let line: number | undefined

    for (const entry of diff.split("\n")) {
      if (entry.startsWith("+++ ")) {
        let value = entry.slice(4)

        if (value === "/dev/null") continue

        if (value.startsWith('"') && value.endsWith('"'))
          try {
            value = JSON.parse(value)
          } catch {
            value = value.slice(1, -1)
          }

        path = value.startsWith("b/") ? value.slice(2) : value
        line = undefined

        continue
      }

      if (entry.startsWith("@@ ")) {
        const match = entry.match(/\+(\d+)(?:,\d+)?/)

        line = match ? Number(match[1]) : undefined

        continue
      }

      if (!path || line == null) continue

      if (entry.startsWith("+") || entry.startsWith(" ")) {
        const lines = inlineCommentTargets[path] ?? []

        lines.push(line)
        inlineCommentTargets[path] = lines

        line += 1
      }
    }

    return inlineCommentTargets
  }
  const baseSha = this.state.pr.metadata.base.sha
  const headSha = this.state.pr.metadata.head.sha
  const inlineCommentTargets: PullRequestInlineCommentTargets = {
    [baseSha]: await get(["base", baseSha], ["head", headSha]),
  }
  const reviewers = Object.entries(this.state.reviewers)

  for (const [id, { review, status }] of reviewers) {
    if (status !== "rereview") continue
    if (!review?.commit_id)
      throw new MagiError(
        "blocked",
        `Missing previous review commit for reviewer ${id}.`,
      )

    const previousHeadSha = review.commit_id

    if (!inlineCommentTargets[previousHeadSha])
      inlineCommentTargets[previousHeadSha] = await get(
        ["head", previousHeadSha],
        ["head", headSha],
      )
  }

  return inlineCommentTargets
}

async function hasCommit(this: Review, sha: string): Promise<boolean> {
  if (!this.state.worktree)
    throw new MagiError("blocked", "PR worktree not found.")

  try {
    await this.exec(
      command("git", "cat-file", "-e", quote(`${sha}^{commit}`)),
      {
        cwd: this.state.worktree.path,
        signal: this.context.abort,
      },
    )

    return true
  } catch {
    return false
  }
}
