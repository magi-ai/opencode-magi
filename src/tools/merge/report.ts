import type { Merge } from "./merge"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { MagiError } from "@/magi"
import {
  createCheckContent,
  createMetaContent,
  createReviewerContent,
} from "@/tools/review/report"
import { filterEmpty, toTitleCase } from "@/utils"

export async function createReport(this: Merge, e?: unknown) {
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
  this: Merge,
  input: { error?: string; status: string },
): string {
  return filterEmpty([
    ...createMetaContent.call(this, input),
    ...createCheckContent.call(this),
    ...createReviewerContent.call(this),
  ]).join("\n")
}
