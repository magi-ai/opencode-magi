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
  ]).join("\n")
}
