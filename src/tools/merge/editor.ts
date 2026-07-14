import type { EditOutput } from "./index.type"
import type { Merge } from "./merge"
import type {
  PullRequestMetadata,
  PullRequestReviewThread,
} from "@/tools/review"
import { MagiError } from "@/magi"
import { Prompt } from "@/prompts"
import { getMetadata } from "@/tools/review/check"
import { command, filterDuplicates, filterEmpty, quote, retry } from "@/utils"

type EditPromptOutput = Omit<EditOutput, "filesTouched"> & {
  filesTouched?: string[]
}

export async function edit(this: Merge): Promise<boolean> {
  this.context.abort.throwIfAborted()

  await this.updateEvent(`Editing.`)

  await setAccount.call(this)

  const unresolvedThreads = await getUnresolvedThreads.call(this)
  const threads = this.state.dryRun
    ? [...createSyntheticThreads.call(this), ...unresolvedThreads]
    : unresolvedThreads

  if (!threads.length)
    throw new MagiError("blocked", "No editable review threads found.")

  const cycle = (this.state.editor!.outputs?.length ?? 0) + 1
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

      await this.createAgentFile("edit", "editor", raw, count, cycle)

      const parsed = prompt.parse(raw)

      if (!prompt.validate<EditPromptOutput>(parsed))
        throw new Error("Invalid output for editor.")

      const output: EditOutput = {
        ...parsed,
        filesTouched: parsed.filesTouched ?? [],
      }

      if (output.mode === "EDITED") {
        const head = await this.exec(command("git", "rev-parse", "HEAD"), {
          cwd: this.state.worktree!.path,
          signal: this.context.abort,
        })

        if (head !== output.commitSha)
          throw new Error(
            `Editor reported commit ${output.commitSha}, but worktree HEAD is ${head}.`,
          )
      }

      return output
    },
    {
      error: (_, count) =>
        this.updateEvent(`Attempt ${count} failed to edit. Retrying...`),
      retries: this.config.output.repairAttempts,
    },
  )

  if (!output) throw new MagiError("blocked", "Invalid output for editor.")

  await this.updateState({
    editor: { outputs: [...(this.state.editor!.outputs ?? []), output] },
  })

  await this.updateEvent(
    filterEmpty([
      `Finished editing.`,
      `Result: ${output.mode.toLocaleLowerCase()}.`,
      output.commitSha
        ? `Commit: ${output.commitSha}${output.commitMessage ? ` ${output.commitMessage}` : ""}`
        : undefined,
      output.filesTouched.length
        ? `Files touched:\n${output.filesTouched.map((file) => `- ${file}`).join("\n")}`
        : undefined,
      output.responses.length
        ? `Responses:\n${output.responses
            .map(
              ({ action, body, commentId }) =>
                `- ${action} comment ${commentId}: ${body}`,
            )
            .join("\n")}`
        : undefined,
    ]).join("\n\n"),
  )

  if (output.mode === "EDITED")
    if (this.state.dryRun) {
      await this.updateState({
        pr: {
          files: filterDuplicates([
            ...(this.state.pr?.files ?? []),
            ...output.filesTouched,
          ]),
          metadata: { head: { sha: output.commitSha! } },
        },
      })
      await this.updateEvent(`Skipped pushing editor changes during dry run.`)
    } else {
      await this.updateEvent(`Pushing editor changes.`)

      const pr = await push.call(this)

      await this.updateState({ pr })
      await this.updateEvent(`Finished pushing editor changes.`)
    }

  return output.mode === "EDITED" && !this.state.dryRun
}

export async function resolveConflict(this: Merge): Promise<void> {
  this.context.abort.throwIfAborted()

  await this.updateEvent(`Resolving merge conflicts.`)

  if (!this.state.pr?.metadata)
    throw new MagiError("blocked", "PR metadata not found.")

  const options = { cwd: this.state.worktree!.path, signal: this.context.abort }

  await setAccount.call(this)
  await this.exec(
    command(
      "git",
      "fetch",
      "--no-tags",
      quote(this.state.pr.metadata.base.repo.clone_url),
      quote(`refs/heads/${this.state.pr.metadata.base.ref}`),
    ),
    options,
  )

  const conflictedFiles = await getConflictedFiles.call(this)

  if (!conflictedFiles.length)
    throw new MagiError("blocked", "No merge conflicts found in worktree.")

  const cycle = (this.state.editor!.outputs?.length ?? 0) + 1
  const prompt = await Prompt.init(this.magi, this.config, "merge/conflict")
  const taskMessage = await prompt.create(
    undefined,
    [
      "output_contract",
      ["conflicted_files", JSON.stringify(conflictedFiles, null, 2)],
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

      await this.createAgentFile("conflict", "editor", raw, count, cycle)

      const parsed = prompt.parse(raw)

      if (!prompt.validate<{ [key: string]: never }>(parsed))
        throw new Error("Invalid output for conflict editor.")

      const diff = await this.exec(
        command("git", "diff", "--name-only", "--diff-filter=U"),
        options,
      )

      if (diff) throw new Error("Merge conflicts remain.")

      const commitSha = await this.exec(
        command("git", "rev-parse", "HEAD"),
        options,
      )

      if (commitSha === this.state.pr!.metadata!.head.sha)
        throw new Error("Conflict editor did not create a commit.")

      const parents = await this.exec(
        command("git", "rev-list", "--parents", "-n", "1", "HEAD"),
        options,
      )

      if (parents.split(" ").length < 3)
        throw new Error("Conflict editor did not create a merge commit.")

      const commitMessage = await this.exec(
        command("git", "log", "-1", "--pretty=%s"),
        options,
      )

      return {
        commitMessage,
        commitSha,
        filesTouched: conflictedFiles,
        mode: "RESOLVED",
        responses: [],
      }
    },
    {
      error: (_, count) =>
        this.updateEvent(
          `Attempt ${count} failed to resolve conflicts. Retrying...`,
        ),
      retries: this.config.output.repairAttempts,
    },
  )

  if (!output)
    throw new MagiError("blocked", "Invalid output for conflict editor.")

  await this.updateState({
    editor: { outputs: [...(this.state.editor!.outputs ?? []), output] },
  })
  await this.updateEvent(`Finished resolving merge conflicts.`)

  if (this.state.dryRun) {
    await this.updateState({
      pr: {
        files: filterDuplicates([
          ...(this.state.pr.files ?? []),
          ...output.filesTouched,
        ]),
        metadata: { head: { sha: output.commitSha! } },
      },
    })
    await this.updateEvent(
      `Skipped pushing conflict resolution during dry run.`,
    )
  } else {
    await this.updateEvent(`Pushing conflict resolution.`)

    const pr = await push.call(this)

    await this.updateState({ pr })
    await this.updateEvent(`Finished pushing conflict resolution.`)
  }
}

async function setAccount(this: Merge): Promise<void> {
  if (!this.state.editor?.sessionId)
    throw new MagiError("blocked", "Editor session ID not found.")
  if (!this.state.editor.author)
    throw new MagiError("blocked", "Editor author not found.")
  if (!this.state.worktree)
    throw new MagiError("blocked", "PR worktree not found.")

  const options = { cwd: this.state.worktree.path, signal: this.context.abort }

  await this.exec(
    command("git", "config", "user.name", quote(this.state.editor.author.name)),
    options,
  )
  await this.exec(
    command(
      "git",
      "config",
      "user.email",
      quote(this.state.editor.author.email),
    ),
    options,
  )
}

async function push(
  this: Merge,
): Promise<{ files: string[]; metadata: PullRequestMetadata }> {
  if (!this.state.editor?.account)
    throw new MagiError("blocked", "Editor account not found.")
  if (!this.state.pr?.metadata)
    throw new MagiError("blocked", "PR metadata not found.")
  if (!this.state.worktree)
    throw new MagiError("blocked", "PR worktree not found.")

  const token = await this.magi.getGhToken(this.state.editor.account)
  const url = `https://${this.config.github.host}/${this.state.pr.metadata.head.repo.owner.login}/${this.state.pr.metadata.head.repo.name}.git`
  const ref = `HEAD:refs/heads/${this.state.pr.metadata.head.ref}`

  await this.exec(command("git", "push", quote(url), quote(ref)), {
    cwd: this.state.worktree.path,
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
    signal: this.context.abort,
  })

  return getMetadata.call(this)
}

async function getConflictedFiles(this: Merge): Promise<string[]> {
  if (!this.state.worktree)
    throw new MagiError("blocked", "PR worktree not found.")

  const options = { cwd: this.state.worktree.path, signal: this.context.abort }

  try {
    await this.exec(
      command("git", "merge", "--no-commit", "--no-ff", "FETCH_HEAD"),
      options,
    )
    await this.exec(command("git", "merge", "--abort"), options)

    return []
  } catch {
    const result = await this.exec(
      command("git", "diff", "--name-only", "--diff-filter=U"),
      options,
    )

    if (!result) {
      await this.exec(command("git", "merge", "--abort"), options)

      return []
    }

    return result.split("\n")
  }
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
    ([reviewer, { outputs }]) => {
      const output = outputs?.at(-1)

      if (output?.verdict !== "CHANGES_REQUESTED") return []

      const findings = output.findings ?? output.newFindings ?? []

      return findings.map((finding) => ({ ...finding, reviewer }))
    },
  )

  return findings.map(({ body, line, path, reviewer, state }, index) => ({
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
    state,
  }))
}
