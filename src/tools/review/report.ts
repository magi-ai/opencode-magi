import type { Review } from "./review"
import { MagiError } from "@/magi"
import { toTitleCase } from "@/utils"

export async function createReport(this: Review, e?: unknown) {
  if (!e) {
    return this.magi.updateState(this.state.output, {
      completedAt: new Date().toISOString(),
      status: "completed",
      text: `Finished reviewing ${this.getLink()}.`,
    })
  } else {
    const error = e instanceof Error ? e.message : "Unknown error"
    const status =
      e instanceof MagiError
        ? e.status
        : this.context.abort.aborted
          ? "cancelled"
          : "failed"

    return this.magi.updateState(this.state.output, {
      completedAt: new Date().toISOString(),
      error,
      status,
      text: `${toTitleCase(status)} reviewing ${this.getLink()}: ${error}`,
    })
  }
}
