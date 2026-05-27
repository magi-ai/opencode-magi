import { describe, expect, test } from "vitest"
import {
  aggregateMajority,
  closeMinorityReviewers,
  majorityThreshold,
  mergeVerdictForPolicy,
} from "./majority"

describe("majority", () => {
  test("calculates threshold", () => {
    expect(majorityThreshold(3)).toBe(2)
    expect(majorityThreshold(5)).toBe(3)
    expect(majorityThreshold(7)).toBe(4)
  })

  test("aggregates majority verdict", () => {
    const result = aggregateMajority([
      { reviewer: "a", verdict: "MERGE" },
      { reviewer: "b", verdict: "CHANGES_REQUESTED" },
      { reviewer: "c", verdict: "CHANGES_REQUESTED" },
    ])

    expect(result.verdict).toBe("CHANGES_REQUESTED")
    expect(result.threshold).toBe(2)
    expect(result.reviewers.CHANGES_REQUESTED).toEqual(["b", "c"])
  })

  test("rejects even result count", () => {
    expect(() =>
      aggregateMajority([
        { reviewer: "a", verdict: "MERGE" },
        { reviewer: "b", verdict: "MERGE" },
      ]),
    ).toThrow("majority requires an odd number of at least 3 reviewer results")
  })

  test("keeps majority policy behavior for merge decisions", () => {
    expect(
      mergeVerdictForPolicy(
        [
          { reviewer: "a", verdict: "MERGE" },
          { reviewer: "b", verdict: "MERGE" },
          { reviewer: "c", verdict: "CHANGES_REQUESTED" },
        ],
        "majority",
      ),
    ).toBe("MERGE")
  })

  test("requires all approvals for unanimous merge decisions", () => {
    expect(
      mergeVerdictForPolicy(
        [
          { reviewer: "a", verdict: "MERGE" },
          { reviewer: "b", verdict: "MERGE" },
          { reviewer: "c", verdict: "CHANGES_REQUESTED" },
        ],
        "unanimous",
      ),
    ).toBe("CHANGES_REQUESTED")
  })

  test("keeps close majority independent from approval policy", () => {
    expect(
      mergeVerdictForPolicy(
        [
          { reviewer: "a", verdict: "CLOSE" },
          { reviewer: "b", verdict: "CLOSE" },
          { reviewer: "c", verdict: "MERGE" },
        ],
        "unanimous",
      ),
    ).toBe("CLOSE")
  })

  test("identifies close minority reviewers for reconsideration", () => {
    expect(
      closeMinorityReviewers([
        { reviewer: "a", verdict: "MERGE" },
        { reviewer: "b", verdict: "MERGE" },
        { reviewer: "c", verdict: "CLOSE" },
      ]),
    ).toEqual(["c"])
  })
})
