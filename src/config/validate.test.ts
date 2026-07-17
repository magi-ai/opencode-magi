import type { Config } from "."
import { describe, expect, test } from "vitest"
import { DEFAULT_CONFIG } from "@/constant"
import { validateConfig } from "./validate"

function config(): Config.Root {
  const result = structuredClone(DEFAULT_CONFIG)

  result.account = "account"
  result.github.owner = "owner"
  result.github.repo = "repo"

  return result
}

describe("validateConfig", () => {
  test("allows configurations without editor or creator", async () => {
    await expect(validateConfig(config())).resolves.toStrictEqual([])
  })

  test("requires an editor when requested", async () => {
    await expect(
      validateConfig(config(), { require: { editor: true } }),
    ).resolves.toStrictEqual([
      "merge.editor is required",
      "merge.editor.model is required",
      "merge.editor.author is required",
    ])
  })

  test("requires a creator when requested", async () => {
    await expect(
      validateConfig(config(), { require: { creator: true } }),
    ).resolves.toStrictEqual([
      "triage.creator is required",
      "triage.creator.model is required",
      "triage.creator.author is required",
    ])
  })
})
