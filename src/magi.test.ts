import type { PluginInput as OriginalPluginInput } from "@opencode-ai/plugin"
import { describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  createOpencodeClient: vi.fn(),
}))

vi.mock("@opencode-ai/sdk/v2", () => ({
  createOpencodeClient: mocks.createOpencodeClient,
}))

import { Magi } from "./magi"

describe("Magi", () => {
  test("preserves the caller's configured fetch", () => {
    const fetch = vi.fn()
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

    new Magi(input)

    expect(mocks.createOpencodeClient).toHaveBeenCalledWith({
      baseUrl: "http://localhost/",
      directory: "/test",
      fetch,
    })
  })
})
