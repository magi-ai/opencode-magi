import type { PluginInput as OriginalPluginInput } from "@opencode-ai/plugin"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  createOpencodeClient: vi.fn(),
}))

vi.mock("@opencode-ai/sdk/v2", () => ({
  createOpencodeClient: mocks.createOpencodeClient,
}))

import { Magi } from "./magi"

function createMagi(fetch?: typeof globalThis.fetch): {
  magi: Magi
  session: {
    create: ReturnType<typeof vi.fn>
    prompt: ReturnType<typeof vi.fn>
  }
} {
  const session = {
    create: vi.fn(),
    prompt: vi.fn(),
  }
  const input = {
    client: {
      session: {
        _client: {
          getConfig: () => ({ fetch }),
        },
      },
    },
    directory: "/test",
    serverUrl: new URL("http://localhost"),
  } as unknown as OriginalPluginInput

  mocks.createOpencodeClient.mockReturnValue({ session })

  return { magi: new Magi(input), session }
}

describe("Magi session API errors", () => {
  beforeEach(() => {
    mocks.createOpencodeClient.mockReset()
  })

  test("preserves the caller's configured fetch", () => {
    const fetch = vi.fn()

    createMagi(fetch)

    expect(mocks.createOpencodeClient).toHaveBeenCalledWith({
      baseUrl: "http://localhost/",
      directory: "/test",
      fetch,
    })
  })

  test("prefers a session API response status text", async () => {
    const { magi, session } = createMagi()

    session.create.mockResolvedValue({
      error: new Error("request failed"),
      response: { statusText: "Bad Gateway" },
    })

    await expect(
      magi.createSession("parent", "title", {
        model: { id: "provider/model" },
      }),
    ).rejects.toThrow("Bad Gateway")
  })

  test("uses an Error message when a session API response is absent", async () => {
    const { magi, session } = createMagi()

    session.prompt.mockResolvedValue({
      error: new Error("connection refused"),
    })

    await expect(magi.promptSession("session", "text")).rejects.toThrow(
      "connection refused",
    )
  })

  test("serializes non-Error session API failures", async () => {
    const { magi, session } = createMagi()

    session.prompt.mockResolvedValue({
      error: { code: "ECONNRESET" },
    })

    await expect(magi.promptSession("session", "text")).rejects.toThrow(
      '{"code":"ECONNRESET"}',
    )
  })
})
