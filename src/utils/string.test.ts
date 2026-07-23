import { command, marker, quote, split, toTitleCase } from "./string"

describe("quote", () => {
  test("wraps a value in single quotes", () => {
    expect(quote("hello world")).toBe("'hello world'")
  })

  test("escapes embedded single quotes for a shell command", () => {
    expect(quote("it's ready")).toBe("'it'\\''s ready'")
  })
})

describe("split", () => {
  test("splits on comma and whitespace sequences", () => {
    expect(split("alpha, beta\ngamma\tdelta")).toStrictEqual([
      "alpha",
      "beta",
      "gamma",
      "delta",
    ])
  })

  test("returns a single value unchanged", () => {
    expect(split("alpha")).toStrictEqual(["alpha"])
  })
})

describe("toTitleCase", () => {
  test("separates camel case words", () => {
    expect(toTitleCase("pullRequestReview")).toBe("Pull Request Review")
  })

  test("converts snake and kebab case separators", () => {
    expect(toTitleCase("pull_request-review")).toBe("Pull Request Review")
  })

  test("trims surrounding whitespace", () => {
    expect(toTitleCase("  Ready  ")).toBe("Ready")
  })
})

describe("command", () => {
  test("joins command parts with spaces", () => {
    expect(command("gh", "pr", "view", 42)).toBe("gh pr view 42")
  })

  test("omits nullish parts while preserving other falsy values", () => {
    expect(command("run", null, 0, false, undefined)).toBe("run 0 false")
  })
})

describe("marker.parse", () => {
  test("parses all markers and preserves equals signs in values", () => {
    expect(
      marker.parse(
        "before <!-- opencode-magi command=review token=left=right --> after\n<!-- opencode-magi status=ready -->",
      ),
    ).toStrictEqual([
      { command: "review", token: "left=right" },
      { status: "ready" },
    ])
  })

  test("ignores malformed marker attributes", () => {
    expect(
      marker.parse("<!-- opencode-magi valid=yes invalid =missing -->"),
    ).toStrictEqual([{ valid: "yes" }])
  })

  test("returns an empty array when no marker is present", () => {
    expect(marker.parse("plain text")).toStrictEqual([])
  })
})

describe("marker.stringify", () => {
  test("serializes marker attributes in insertion order", () => {
    expect(marker.stringify({ command: "review", reviewer: "alpha" })).toBe(
      "<!-- opencode-magi command=review reviewer=alpha -->",
    )
  })

  test("joins multiple markers with newlines", () => {
    expect(marker.stringify({ first: 1 }, { second: 2 })).toBe(
      "<!-- opencode-magi first=1 -->\n<!-- opencode-magi second=2 -->",
    )
  })
})
