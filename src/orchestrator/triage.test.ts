import { describe, expect, test } from "vitest"
import { chooseDuplicateOutput } from "./triage"

describe("triage orchestration", () => {
  test("requires majority support for the same duplicate target", () => {
    const result = chooseDuplicateOutput({
      candidateNumbers: [101, 202],
      outputs: [
        { duplicateOf: 101, reason: "same failure", vote: "DUPLICATE" },
        { duplicateOf: 202, reason: "same request", vote: "DUPLICATE" },
        { reason: "not the same", vote: "NOT_DUPLICATE" },
      ],
    })

    expect(result).toBeUndefined()
  })

  test("selects a duplicate target with majority support", () => {
    const result = chooseDuplicateOutput({
      candidateNumbers: [101, 202],
      outputs: [
        { duplicateOf: 101, reason: "same failure", vote: "DUPLICATE" },
        { duplicateOf: 101, reason: "same root cause", vote: "DUPLICATE" },
        { duplicateOf: 202, reason: "similar request", vote: "DUPLICATE" },
      ],
    })

    expect(result?.duplicateOf).toBe(101)
  })

  test("ignores duplicate targets that were not provided as candidates", () => {
    const result = chooseDuplicateOutput({
      candidateNumbers: [101],
      outputs: [
        { duplicateOf: 999, reason: "invalid target", vote: "DUPLICATE" },
        { duplicateOf: 999, reason: "invalid target", vote: "DUPLICATE" },
        { reason: "not the same", vote: "NOT_DUPLICATE" },
      ],
    })

    expect(result).toBeUndefined()
  })
})
