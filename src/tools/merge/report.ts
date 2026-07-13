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

export async function createReport(this: Review, e?: unknown): Promise<string> {
  if (!e) {
    const status = "completed"
    const text = await createContent.call(this, { status })

    await writeFile(join(this.state.output, "report.md"), `${text}\n`)

    await this.updateState({
      completedAt: new Date().toISOString(),
      status,
    })

    return text
  } else {
    const error = e instanceof Error ? e.message : "Unknown error"
    const status =
      e instanceof MagiError
        ? e.status
        : this.context.abort.aborted
          ? "cancelled"
          : "failed"
    const text = await createContent.call(this, { error, status })

    await writeFile(join(this.state.output, "report.md"), `${text}\n`)

    await this.updateState({
      completedAt: new Date().toISOString(),
      status,
    })

    return text
  }
}

async function createContent(
  this: Review,
  input: { error?: string; status: string },
): Promise<string> {
  return filterEmpty([
    ...(await createMetaContent.call(this, input)),
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
          `  - **Cycle ${index + 1}**: ${toTitleCase(output.mode.toLocaleLowerCase())}`,
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
              `      - **${toTitleCase(action.toLocaleLowerCase())}** \`${prefix}\`: ${body}`,
            )
          }
        }

        return lines
      }),
    ].join("\n"),
  ]
}
