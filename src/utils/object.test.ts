import { describe, expect, test } from "vitest"
import { filterObject, merge, omitNullish } from "./object"

describe("merge", () => {
  test("recursively merges nested objects", () => {
    expect(
      merge(
        { enabled: true, nested: { left: 1, shared: "base" } },
        { nested: { right: 2, shared: "override" } },
      ),
    ).toStrictEqual({
      enabled: true,
      nested: { left: 1, right: 2, shared: "override" },
    })
  })

  test("replaces values that are not objects on both sides", () => {
    expect(
      merge(
        { mode: { name: "base" }, values: [1] },
        { mode: "override", values: [2] },
      ),
    ).toStrictEqual({ mode: "override", values: [2] })
  })

  test("does not mutate either input", () => {
    const base = { nested: { left: 1 } }
    const override = { nested: { right: 2 } }

    merge(base, override)

    expect(base).toStrictEqual({ nested: { left: 1 } })
    expect(override).toStrictEqual({ nested: { right: 2 } })
  })
})

describe("filterObject", () => {
  test("keeps entries accepted by the predicate", () => {
    expect(
      filterObject({ first: 1, second: 2 }, (_, value) => value > 1),
    ).toStrictEqual({
      second: 2,
    })
  })

  test("passes each key, value, and the source object to the predicate", () => {
    const source = { first: 1 }
    const calls: unknown[][] = []

    filterObject(source, (...args) => {
      calls.push(args)

      return true
    })

    expect(calls).toStrictEqual([["first", 1, source]])
  })
})

describe("omitNullish", () => {
  test("removes nullish entries while preserving other falsy values", () => {
    expect(
      omitNullish({ empty: "", false: false, null: null, undefined, zero: 0 }),
    ).toStrictEqual({ empty: "", false: false, zero: 0 })
  })
})
