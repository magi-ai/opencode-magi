import type { Merge } from "./merge"
import type { PullRequestReviewThread } from "@/tools/review"
import { MagiError } from "@/magi"
import { Prompt } from "@/prompts"
import { command, filterEmpty, quote, retry } from "@/utils"

interface EditOutput {
  commitMessage?: string
  commitSha?: string
  filesTouched: string[]
  mode: "EDITED" | "REPLIED"
  responses: {
    action: "ASK" | "DISAGREE" | "FIXED"
    body: string
    commentId: number
  }[]
}

export async function edit(this: Merge) {
  this.context.abort.throwIfAborted()

  if (!this.state.editor?.sessionId)
    throw new MagiError("blocked", "Editor session ID not found.")
  if (!this.state.editor.author)
    throw new MagiError("blocked", "Editor author not found.")
  if (!this.state.reviewers)
    throw new MagiError("blocked", "Reviewers not found.")
  if (!this.state.worktree)
    throw new MagiError("blocked", "PR worktree not found.")

  this.state = await this.magi.updateState(this.state.output, {
    text: `Editing ${this.getLink()}.`,
  })

  await this.exec(
    command(
      "git",
      "config",
      "user.name",
      quote(this.state.editor!.author.name),
    ),
    {
      cwd: this.state.worktree!.path,
      signal: this.context.abort,
    },
  )
  await this.exec(
    command(
      "git",
      "config",
      "user.email",
      quote(this.state.editor!.author.email),
    ),
    {
      cwd: this.state.worktree!.path,
      signal: this.context.abort,
    },
  )

  const unresolvedThreads = await getUnresolvedThreads.call(this)
  const threads = this.state.dryRun
    ? [...createSyntheticThreads.call(this), ...unresolvedThreads]
    : unresolvedThreads

  if (!threads.length)
    throw new MagiError("blocked", "No editable review threads found.")

  const prompt = await Prompt.init(this.magi, this.config, "merge/edit")
  const taskMessage = await prompt.create(
    this.config.merge.prompts?.edit,
    [
      "output_contract",
      ["unresolved_threads", JSON.stringify(threads, null, 2)],
    ],
    {
      owner: this.config.github.owner,
      pr: this.number.toString(),
      repo: this.config.github.repo,
      worktreePath: this.state.worktree!.path,
    },
  )
  const repairMessage = await prompt.repair()
  const output = await retry<EditOutput>(
    async (count) => {
      const raw = await this.magi.promptSession(
        this.state.editor!.sessionId!,
        count === 1 ? taskMessage : repairMessage,
      )
      const parsed = prompt.parse(raw)

      if (!prompt.validate<EditOutput>(parsed))
        throw new Error("Invalid output for editor.")

      if (parsed.mode === "EDITED") {
        const head = (
          await this.exec(command("git", "rev-parse", "HEAD"), {
            cwd: this.state.worktree!.path,
            signal: this.context.abort,
          })
        ).trim()

        if (head !== parsed.commitSha)
          throw new Error(
            `Editor reported commit ${parsed.commitSha}, but worktree HEAD is ${head}.`,
          )
      }

      return parsed
    },
    {
      error: (_, count) =>
        this.magi.notify(
          this.state.sessionId,
          `Attempt ${count} failed to edit ${this.getLink()}. Retrying...`,
        ),
      retries: this.config.output.repairAttempts,
    },
  )

  if (!output) throw new MagiError("blocked", "Invalid output for editor.")

  this.state = await this.magi.updateState(this.state.output, {
    text: `Finished editing ${this.getLink()}.`,
  })

  return output
}

async function getUnresolvedThreads(this: Merge) {
  const data = await this.graphql.paginate(this.graphql.reviewThreads, {
    owner: this.config.github.owner,
    pr: this.number,
    repo: this.config.github.repo,
  })

  return (data.repository?.pullRequest?.reviewThreads.nodes ?? []).flatMap(
    (node) => {
      if (!node || node.isResolved) return []

      return [{ ...node, comments: filterEmpty(node.comments.nodes ?? []) }]
    },
  )
}

function createSyntheticThreads(this: Merge): PullRequestReviewThread[] {
  const findings = Object.entries(this.state.reviewers ?? {}).flatMap(
    ([reviewer, { output }]) => {
      if (output?.verdict !== "CHANGES_REQUESTED") return []

      const findings = output.findings ?? output.newFindings ?? []

      return findings.map((finding) => ({ ...finding, reviewer }))
    },
  )

  return findings.map(({ body, line, path, reviewer }, index) => ({
    comments: [
      {
        author: { login: reviewer },
        body,
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
