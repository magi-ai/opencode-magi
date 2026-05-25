import Ajv2020 from "ajv/dist/2020"
import { describe, expect, test } from "vitest"
import schema from "../../schema.json" with { type: "json" }

describe("schema", () => {
  test("accepts merge conflict automation", () => {
    const ajv = new Ajv2020()
    const validate = ajv.compile(schema)

    expect(
      validate({
        github: { owner: "owner", repo: "repo" },
        merge: { automation: { conflict: true } },
      }),
    ).toBe(true)
  })

  test("accepts single review mode without reviewer accounts", () => {
    const ajv = new Ajv2020()
    const validate = ajv.compile(schema)

    expect(
      validate({
        github: { owner: "owner", repo: "repo" },
        review: {
          account: "review-bot",
          mode: "single",
          reviewers: [
            { id: "general", model: "openai/gpt" },
            { id: "security", model: "openai/gpt" },
            { id: "compat", model: "openai/gpt" },
          ],
        },
      }),
    ).toBe(true)
  })

  test("rejects unsupported review mode", () => {
    const ajv = new Ajv2020()
    const validate = ajv.compile(schema)

    expect(
      validate({
        github: { owner: "owner", repo: "repo" },
        review: { mode: "solo" },
      }),
    ).toBe(false)
  })
})
