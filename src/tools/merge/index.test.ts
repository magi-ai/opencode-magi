import { afterEach, describe, expect, test, vi } from "vitest"
import { merge } from "./index"
import { Merge } from "./merge"

interface FailedRun {
  checkPr: ReturnType<typeof vi.fn>
  cleanup: ReturnType<typeof vi.fn>
  createReport: ReturnType<typeof vi.fn>
}

interface SuccessfulRun extends FailedRun {
  automate: ReturnType<typeof vi.fn>
  checkCi: ReturnType<typeof vi.fn>
  checkExistingReviews: ReturnType<typeof vi.fn>
  resolveVerdict: ReturnType<typeof vi.fn>
}

function failedRun(report: string): FailedRun {
  return {
    checkPr: vi.fn().mockRejectedValue(new Error("run failed")),
    cleanup: vi.fn().mockResolvedValue(undefined),
    createReport: vi.fn().mockResolvedValue(report),
  }
}

function successfulRun(report: string): SuccessfulRun {
  return {
    automate: vi.fn().mockResolvedValue(undefined),
    checkCi: vi.fn().mockResolvedValue(undefined),
    checkExistingReviews: vi.fn().mockResolvedValue(true),
    checkPr: vi.fn().mockResolvedValue(undefined),
    cleanup: vi.fn().mockResolvedValue(undefined),
    createReport: vi.fn().mockResolvedValue(report),
    resolveVerdict: vi.fn().mockResolvedValue("MERGE"),
  }
}

describe("scenario: /magi:merge", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  test("throws reports from all failed pull request runs", async () => {
    const first = successfulRun("Report for #1")
    const second = failedRun("Report for #2")
    const third = failedRun("Report for #3")
    const init = vi
      .spyOn(Merge, "init")
      .mockResolvedValueOnce(first as never)
      .mockResolvedValueOnce(second as never)
      .mockResolvedValueOnce(third as never)
    const tool = merge({
      getConfig: vi.fn().mockResolvedValue({
        review: { concurrency: { runs: 1 } },
      }),
    } as never).magi_merge

    if (!tool) throw new Error("Merge tool is unavailable.")

    await expect(
      tool.execute({ prs: "1,2,3" }, {
        abort: new AbortController().signal,
      } as never),
    ).rejects.toThrow("Report for #2\n\nReport for #3")

    expect(init).toHaveBeenCalledTimes(3)
    expect(first.createReport).toHaveBeenCalledWith()
    expect(second.createReport).toHaveBeenCalledWith(expect.any(Error))
    expect(third.createReport).toHaveBeenCalledWith(expect.any(Error))
  })
})
