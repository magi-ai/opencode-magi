import type { Review } from "./review"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { MagiError } from "@/magi"
import { filterEmpty, toTitleCase } from "@/utils"

export async function createReport(this: Review, e?: unknown) {
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
      text: `${toTitleCase(status)} reviewing ${this.getLink()}.\n\n${text}`,
    })
  }
}

function createContent(
  this: Review,
  input: { error?: string; status: string },
) {
  const checks = this.state.pr?.checks
  const reviewers = Object.entries(this.state.reviewers ?? {})

  const rows: (null | string | undefined)[] = [
    `- **Pull Request:** ${this.getLink()}`,
    `- **Mode**: ${toTitleCase(this.config.mode)}`,
    `- **Dry run**: ${this.state.dryRun ? "Yes" : "No"}`,
    `- **Status**: ${toTitleCase(input.status)}`,
  ]

  if (this.state.pr?.verdict) {
    rows.push(`- **Verdict**: ${this.state.pr.verdict}`)
  }

  if (this.state.text) rows.push(`- **Last action**: ${this.state.text}`)
  if (input.error) rows.push(`- **Error**: ${input.error}`)

  if (checks) {
    const failures = [
      ...checks.failed.map((check) => ({
        comments: Object.entries(check.classifieds ?? {}).map(
          ([reviewer, { comment, scope }]) => ({ comment, reviewer, scope }),
        ),
        detail:
          check.scope == null
            ? "Failed"
            : check.scope
              ? "In-scope failure"
              : "Out-of-scope failure",
        name: check.name,
      })),
      ...checks.pending.map((check) => ({
        comments: [],
        detail: "Pending",
        name: check.name,
      })),
    ]

    if (failures.length) {
      rows.push(
        "- **Check**: Failure",
        ...failures.flatMap(({ comments, detail, name }) => [
          `  - **${name}**: ${detail}`,
          ...comments.map(
            ({ comment, reviewer, scope }) =>
              `    - **${reviewer}**: ${scope ? "In scope" : "Out of scope"}. ${comment}`,
          ),
        ]),
      )
    } else {
      rows.push("- **Check**: Pass")
    }
  }

  if (reviewers.length) {
    rows.push(
      [
        "- **Reviewer**:",
        ...reviewers.flatMap(
          ([id, { output, posted, previousOutput, review }]) => {
            if (!output) return []

            const url = posted ?? review?.html_url
            const status = toTitleCase(output.verdict)
            const previousStatus = previousOutput?.verdict
              ? toTitleCase(previousOutput.verdict)
              : undefined
            const lines = [
              `  - **${id}**: ${previousStatus ? `${previousStatus} -> ` : ""}${url ? `[${status}](${url})` : status}`,
            ]

            if (output.verdict === "CLOSED")
              lines.push(`    - ${output.comment ?? review?.body}`)

            if (previousOutput?.verdict === "CLOSED") {
              lines.push(`    - ~~${previousOutput.comment ?? review?.body}~~`)
            }

            if (
              previousOutput?.verdict === "CHANGES_REQUESTED" &&
              output.verdict === "APPROVED"
            ) {
              const findings =
                previousOutput.findings ?? previousOutput.newFindings ?? []

              for (const { body, line, path, startLine } of findings) {
                const prefix = `${path}:${startLine != null ? `${startLine}-` : ""}${line}`

                lines.push(`    - ~~\`${prefix}\`: ${body}~~`)
              }
            }

            if (output.verdict === "CHANGES_REQUESTED") {
              const findings = output.findings ?? output.newFindings ?? []
              const followUps = output.followUps ?? []

              for (const { body, line, path, startLine } of findings) {
                const prefix = `${path}:${startLine != null ? `${startLine}-` : ""}${line}`

                lines.push(`    - \`${prefix}\`: ${body}`)
              }

              for (const { body, commentId } of followUps) {
                const thread = this.state.pr?.threads?.find(({ comments }) =>
                  comments.some(({ databaseId }) => databaseId === commentId),
                )

                if (!thread) continue

                const prefix = `${thread.path}:${thread.line ?? "N/A"}`

                lines.push(`    - \`${prefix}\`: ${body}`)
              }
            }

            return lines
          },
        ),
      ].join("\n"),
    )
  }

  return filterEmpty(rows).join("\n")
}
