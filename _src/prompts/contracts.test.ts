import { describe, expect, test } from "vitest"
import { repairPrompt } from "./contracts"

describe("repairPrompt", () => {
  test("resends the output contract", () => {
    const prompt = repairPrompt("review")

    expect(prompt).toContain(
      "Your previous review output did not match the required schema.",
    )
    expect(prompt).toContain("<output_contract>")
    expect(prompt).toContain(
      '"verdict": "MERGE" | "CHANGES_REQUESTED" | "CLOSE"',
    )
    expect(prompt).toContain(
      "Do not include analysis, explanation, apologies, markdown, or any text before or after the JSON object.",
    )
  })
})
