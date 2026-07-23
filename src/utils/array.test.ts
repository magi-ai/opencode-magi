import { describe, expect, test } from "vitest"
import { filterDuplicates, filterEmpty } from "./array"

describe("filterDuplicates", () => {
  test("removes duplicate values while preserving their first occurrence order", () => {
    expect(
      filterDuplicates(["beta", "alpha", "beta", "gamma", "alpha"]),
    ).toStrictEqual(["beta", "alpha", "gamma"])
  })

  test("returns an empty array for an empty input", () => {
    expect(filterDuplicates([])).toStrictEqual([])
  })
})

describe("filterEmpty", () => {
  test("removes null and undefined values", () => {
    expect(filterEmpty([null, "value", undefined])).toStrictEqual(["value"])
  })

  test("preserves non-nullish falsy values", () => {
    expect(filterEmpty([0, "", false])).toStrictEqual([0, "", false])
  })
})
