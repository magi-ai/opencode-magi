import type { State } from "@/magi"
import type { Review } from "@/tools/review/review"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { MagiError } from "@/magi"
import {
  createCheckContent,
  createMetaContent,
  createReviewerContent,
} from "@/tools/review/report"
import { filterEmpty, toTitleCase } from "@/utils"

export async function createReport(this: Review, e?: unknown): Promise<State> {
  if (!e) {
    const status = "completed"
    const text = createContent.call(this, { status })

    await writeFile(join(this.state.output, "report.md"), `${text}\n`)

    return this.magi.updateState(this.state.output, {
      completedAt: new Date().toISOString(),
      status,
      text,
    })
  } else {
    const error = e instanceof Error ? e.message : "Unknown error"
    const status =
      e instanceof MagiError
        ? e.status
        : this.context.abort.aborted
          ? "cancelled"
          : "failed"
    const text = createContent.call(this, { error, status })

    await writeFile(join(this.state.output, "report.md"), `${text}\n`)

    return this.magi.updateState(this.state.output, {
      completedAt: new Date().toISOString(),
      error,
      status,
      text: `${toTitleCase(status)} merging ${this.getLink()}.\n\n${text}`,
    })
  }
}

function createContent(
  this: Review,
  input: { error?: string; status: string },
): string {
  return filterEmpty([
    ...createMetaContent.call(this, input),
    ...createCheckContent.call(this),
    ...createReviewerContent.call(this),
    ...createEditorContent.call(this),
  ]).join("\n")
}

function createEditorContent(this: Review): string[] {
  if (!this.state.editor?.outputs?.length) return []

  return [
    [
      "- **Editor**:",
      ...this.state.editor.outputs.flatMap((output, index) => {
        const lines = [
          `  - **Cycle ${index + 1}**: ${toTitleCase(output.mode)}`,
        ]

        if (output.commitSha)
          lines.push(
            `    - **Commit**: \`${output.commitSha}\` ${output.commitMessage}`,
          )

        if (output.filesTouched.length) {
          lines.push("    - **Files touched**:")

          for (const file of output.filesTouched)
            lines.push(`      - \`${file}\``)
        }

        if (output.responses.length) {
          lines.push("    - **Responses**:")

          for (const { action, body, commentId } of output.responses) {
            const thread = this.state.pr?.threads?.find(({ comments }) =>
              comments.some(({ databaseId }) => databaseId === commentId),
            )
            const prefix = thread
              ? `${thread.path}:${thread.line ?? "N/A"}`
              : commentId

            lines.push(
              `      - **${toTitleCase(action)}** \`${prefix}\`: ${body}`,
            )
          }
        }

        return lines
      }),
    ].join("\n"),
  ]
}
