import type { MagiConfig } from "../types"
import { describe, expect, test } from "vitest"
import { mergeMagiConfig } from "./load"
import { resolveRepository } from "./resolve"

const config: MagiConfig = {
  agents: {
    reviewers: [
      {
        model: "anthropic/claude",
        account: "bot-a",
        options: { thinking: { type: "enabled", budgetTokens: 16000 } },
      },
      { id: "security", model: "anthropic/claude", account: "bot-b" },
      { id: "compat", model: "openai/gpt", account: "bot-c" },
    ],
    editor: {
      model: "openai/gpt",
      account: "bot-c",
      author: { email: "bot-c@example.com", name: "Bot C" },
    },
  },
  github: { owner: "owner", repo: "repo" },
  language: "en",
  prompts: { review: "global-review.md" },
}

describe("mergeMagiConfig", () => {
  test("project config overrides global config by deep merge", () => {
    const merged = mergeMagiConfig(
      config as unknown as Record<string, unknown>,
      {
        language: "ja",
        automation: { merge: false },
        merge: { approvalPolicy: "unanimous", mergeQueue: true },
        prompts: { edit: "project-edit.md", review: "project-review.md" },
      },
    ) as unknown as MagiConfig
    const repo = resolveRepository(merged)

    expect(repo.language).toBe("ja")
    expect(repo.merge.method).toBe("squash")
    expect(repo.merge.approvalPolicy).toBe("unanimous")
    expect(repo.merge.mergeQueue).toBe(true)
    expect(repo.automation.merge).toBe(false)
    expect(repo.prompts).toEqual({
      edit: "project-edit.md",
      review: "project-review.md",
    })
  })

  test("project reviewer array replaces global reviewer array", () => {
    const merged = mergeMagiConfig(
      config as unknown as Record<string, unknown>,
      {
        agents: {
          reviewers: [
            { id: "a", model: "openai/gpt", account: "bot-1" },
            { id: "b", model: "openai/gpt", account: "bot-2" },
            { id: "c", model: "openai/gpt", account: "bot-3" },
          ],
        },
      },
    ) as unknown as MagiConfig

    expect(
      merged.agents.reviewers!.map((reviewer) => reviewer.account),
    ).toEqual(["bot-1", "bot-2", "bot-3"])
    expect(merged.agents.editor).toEqual(config.agents.editor)
  })
})
