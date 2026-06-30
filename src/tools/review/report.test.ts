import type { Review } from "./review"
import { describe, expect, it } from "vitest"
import { createMetaContent } from "./report"

describe("createMetaContent", () => {
  test("renders missing automation as none", () => {
    const report = createMetaContent.call(
      {
        config: { mode: "multi" },
        getLink: () => "[#1](https://github.com/magi-ai/opencode-magi/pull/1)",
        state: {
          dryRun: false,
          pr: {
            number: 1,
            url: "https://github.com/magi-ai/opencode-magi/pull/1",
          },
        },
      } as unknown as Review,
      { status: "completed" },
    )

    expect(report).toContain("- **Automation**: none")
  })

  test("renders automation values in title case", () => {
    const report = createMetaContent.call(
      {
        config: { mode: "multi" },
        getLink: () => "[#1](https://github.com/magi-ai/opencode-magi/pull/1)",
        state: {
          dryRun: false,
          pr: {
            automation: "MERGED",
            number: 1,
            url: "https://github.com/magi-ai/opencode-magi/pull/1",
          },
        },
      } as unknown as Review,
      { status: "completed" },
    )

    expect(report).toContain("- **Automation**: Merged")
  })
})
