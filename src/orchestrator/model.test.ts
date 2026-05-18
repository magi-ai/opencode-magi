import { describe, expect, test } from "vitest"
import {
  promptModelText,
  runModelWithRepair,
  toOpenCodePermissionRules,
  type ModelClient,
} from "./model"

describe("promptModelText", () => {
  test("ignores non-text parts when extracting model output", async () => {
    const client: ModelClient = {
      session: {
        create: async () => ({ id: "session-1" }),
        prompt: async () => ({
          parts: [
            { text: "The user is asking...", type: "reasoning" },
            { text: "## claude\n\nVisible answer", type: "text" },
          ],
        }),
      },
    }

    await expect(
      promptModelText({
        client,
        model: "anthropic/claude",
        prompt: "Question?",
        sessionId: "session-1",
      }),
    ).resolves.toBe("## claude\n\nVisible answer")
  })
})

describe("runModelWithRepair", () => {
  test("converts permission config when creating sessions", async () => {
    let createInput: unknown
    const client: ModelClient = {
      session: {
        create: async (input) => {
          createInput = input

          return { id: "session-1" }
        },
        prompt: async () => ({ info: { text: "{}" } }),
      },
    }

    await runModelWithRepair({
      client,
      model: "openai/gpt",
      parse: () => ({}),
      permission: { edit: "deny", read: "allow" },
      prompt: "Review this PR",
      repairAttempts: 0,
      schemaName: "review",
      title: "magi review repo#1 reviewer",
    })

    expect(createInput).toMatchObject({
      body: {
        permission: [
          { action: "deny", pattern: "*", permission: "edit" },
          { action: "allow", pattern: "*", permission: "read" },
        ],
        title: "magi review repo#1 reviewer",
      },
    })
  })

  test("surfaces session create API errors", async () => {
    const client: ModelClient = {
      session: {
        create: async () => ({
          error: { message: "bad permission" },
          response: { status: 400, statusText: "Bad Request" },
        }),
        prompt: async () => ({ info: { text: "{}" } }),
      },
    }

    await expect(
      runModelWithRepair({
        client,
        model: "openai/gpt",
        parse: () => ({}),
        permission: { edit: "deny" },
        prompt: "Review this PR",
        repairAttempts: 0,
        schemaName: "review",
        title: "magi review repo#1 reviewer",
      }),
    ).rejects.toThrow(
      'OpenCode session.create failed (400 Bad Request): {"message":"bad permission"}',
    )
  })

  test("expands string permission shorthand", () => {
    expect(toOpenCodePermissionRules("deny")?.slice(0, 2)).toEqual([
      { action: "deny", pattern: "*", permission: "read" },
      { action: "deny", pattern: "*", permission: "edit" },
    ])
  })
})
