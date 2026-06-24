import type { Review } from "./review"
import type { State } from "@/magi"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { MagiError } from "@/magi"
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
      text: `${toTitleCase(status)} reviewing ${this.getLink()}.\n\n${text}`,
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
  ]).join("\n")
}

export function createMetaContent(
  this: Review,
  input: { error?: string; status: string },
): (null | string | undefined)[] {
  const rows: (null | string | undefined)[] = [
    `- **Pull Request:** ${this.getLink()}`,
    `- **Mode**: ${toTitleCase(this.config.mode)}`,
    `- **Dry run**: ${this.state.dryRun ? "Yes" : "No"}`,
    `- **Status**: ${toTitleCase(input.status)}`,
  ]

  if (this.state.pr?.verdict)
    rows.push(`- **Verdict**: ${this.state.pr.verdict}`)

  if (this.state.text) rows.push(`- **Last action**: ${this.state.text}`)
  if (input.error) rows.push(`- **Error**: ${input.error}`)

  return rows
}

export function createCheckContent(this: Review): string[] {
  const checks = this.state.pr?.checks

  if (!checks) return []

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

  if (failures.length)
    return [
      "- **Check**: Failure",
      ...failures.flatMap(({ comments, detail, name }) => [
        `  - **${name}**: ${detail}`,
        ...comments.map(
          ({ comment, reviewer, scope }) =>
            `    - **${reviewer}**: ${scope ? "In scope" : "Out of scope"}. ${comment}`,
        ),
      ]),
    ]
  else return ["- **Check**: Pass"]
}

export function createReviewerContent(this: Review): string[] {
  const reviewers = Object.entries(this.state.reviewers ?? {})

  if (!reviewers.length) return []

  return [
    [
      "- **Reviewer**:",
      ...reviewers.flatMap(([id, { outputs, posted, review }]) => {
        if (!outputs?.length) return []

        const output = outputs.at(-1)!
        const url = posted ?? review?.html_url
        const status = toTitleCase(output.verdict)
        const prevStatuses = outputs
          .slice(0, -1)
          .map(({ verdict }) => toTitleCase(verdict))
          .reduce<string[]>((prev, current) => {
            if (prev.at(-1) !== current) prev.push(current)

            return prev
          }, [])
        const lines = [
          `  - **${id}**: ${[...prevStatuses, url ? `[${status}](${url})` : status].join(" -> ")}`,
          ...outputs.flatMap((output, index) => {
            const lines = [`    - **Verdict**: ${toTitleCase(output.verdict)}`]
            const latest = index === outputs.length - 1
            const findings = output.findings ?? output.newFindings ?? []

            if (output.verdict === "CLOSED")
              lines.push(
                `      - **Comment**: ${latest ? "" : "~~"}${output.comment ?? review?.body}${latest ? "" : "~~"}`,
              )

            if (findings.length) {
              lines.push("      - **Findings**:")

              for (const { body, line, path, startLine, state } of findings) {
                const discarded = state === "discarded"
                const prefix = `${path}:${startLine != null ? `${startLine}-` : ""}${line}`

                lines.push(
                  `        - ${discarded ? "~~" : ""}\`${prefix}\`: ${body}${discarded ? "~~" : ""}`,
                )
              }
            }

            if (output.followUps?.length) {
              lines.push("      - **FollowUps**:")

              for (const { body, commentId } of output.followUps) {
                const thread = this.state.pr?.threads?.find(({ comments }) =>
                  comments.some(({ databaseId }) => databaseId === commentId),
                )
                const prefix = `${thread?.path ?? "unknown"}:${thread?.line ?? "N/A"}`

                lines.push(`        - \`${prefix}\`: ${body}`)
              }
            }

            return lines
          }),
        ]

        return lines
      }),
    ].join("\n"),
  ]
}
