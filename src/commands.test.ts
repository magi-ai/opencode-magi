import { describe, expect, test } from "vitest"
import { MAGI_COMMANDS } from "./commands"

describe("Magi slash commands", () => {
  test("keeps review and merge templates terse", () => {
    expect(MAGI_COMMANDS["magi:clear"].template).toBe(
      "Call the `magi_clear` tool.",
    )
    expect(MAGI_COMMANDS["magi:review"].template).toBe(
      "Call the `magi_review` tool.\nPR: $ARGUMENTS",
    )
    expect(MAGI_COMMANDS["magi:merge"].template).toBe(
      "Call the `magi_merge` tool.\nPR: $ARGUMENTS",
    )
    expect(MAGI_COMMANDS["magi:triage"].template).toBe(
      "Call the `magi_triage` tool.\nIssue: $ARGUMENTS",
    )
    expect(MAGI_COMMANDS["magi:review"].template).not.toContain("If")
    expect(MAGI_COMMANDS["magi:review"].template).not.toContain("with")
    expect(MAGI_COMMANDS["magi:review"].template).not.toContain("``")
  })
})
