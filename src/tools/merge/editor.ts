import type { EditOutput } from "./index.type"
import type { Merge } from "./merge"
import type { PullRequestReviewThread } from "@/tools/review"
import { MagiError } from "@/magi"
import { Prompt } from "@/prompts"
import { getMetadata } from "@/tools/review/check"
import { command, filterDuplicates, filterEmpty, quote, retry } from "@/utils"

export async function edit(this: Merge): Promise<boolean> {
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

  const signal = this.context.abort
  const cwd = this.state.worktree!.path
  const options = { cwd, signal }

  await this.exec(
    command(
      "git",
      "config",
      "user.name",
      quote(this.state.editor!.author.name),
    ),
    options,
  )
  await this.exec(
    command(
      "git",
      "config",
      "user.email",
      quote(this.state.editor!.author.email),
    ),
    options,
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
          await this.exec(command("git", "rev-parse", "HEAD"), options)
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

  const prevOutput = this.state.editor?.output

  this.state = await this.magi.updateState(this.state.output, {
    editor: {
      history: [
        ...(this.state.editor?.history ?? []),
        ...(prevOutput ? [prevOutput] : []),
      ],
      output,
    },
    text: `Finished editing ${this.getLink()}.`,
  })

  if (output.mode === "EDITED") {
    if (!this.state.editor?.account)
      throw new MagiError("blocked", "Editor account not found.")
    if (!this.state.pr?.metadata)
      throw new MagiError("blocked", "PR metadata not found.")
    if (!this.state.worktree)
      throw new MagiError("blocked", "PR worktree not found.")

    if (this.state.dryRun) {
      this.state = await this.magi.updateState(this.state.output, {
        pr: {
          files: filterDuplicates([
            ...(this.state.pr.files ?? []),
            ...output.filesTouched,
          ]),
          metadata: { head: { sha: output.commitSha! } },
        },
        text: `Skipped pushing editor changes for ${this.getLink()} during dry run.`,
      })
    } else {
      this.state = await this.magi.updateState(this.state.output, {
        text: `Pushing editor changes for ${this.getLink()}.`,
      })

      const token = await this.magi.getGhToken(this.state.editor!.account)
      const url = `https://${this.config.github.host}/${this.state.pr!.metadata.head.repo.owner.login}/${this.state.pr!.metadata.head.repo.name}.git`
      const ref = `HEAD:refs/heads/${this.state.pr!.metadata.head.ref}`

      await this.exec(command("git", "push", quote(url), quote(ref)), {
        ...options,
        env: {
          GIT_CONFIG_COUNT: "2",
          GIT_CONFIG_KEY_0: "credential.helper",
          GIT_CONFIG_KEY_1: "credential.helper",
          GIT_CONFIG_VALUE_0: "",
          GIT_CONFIG_VALUE_1:
            "!f() { echo username=x-access-token; echo password=$GIT_PASSWORD; }; f",
          GIT_PASSWORD: token,
          GIT_TERMINAL_PROMPT: "0",
        },
      })

      const { files, metadata } = await getMetadata.call(this)

      this.state = await this.magi.updateState(this.state.output, {
        pr: { files, metadata },
        text: `Finished pushing editor changes for ${this.getLink()}.`,
      })
    }
  }

  return output.mode === "EDITED" && !this.state.dryRun
}

async function getUnresolvedThreads(
  this: Merge,
): Promise<PullRequestReviewThread[]> {
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
