import type { PluginInput } from "@/utils"
import { readFile } from "node:fs/promises"
import { beforeEach, describe, expect, test, vi } from "vitest"
import { getConfig } from "./resolve"

vi.mock("node:fs/promises", () => ({ readFile: vi.fn() }))

describe("getConfig", () => {
  beforeEach(() => {
    vi.mocked(readFile).mockRejectedValue(
      Object.assign(new Error(), { code: "ENOENT" }),
    )
  })

  test("throws when OpenCode has no available models", async () => {
    const input = {
      client: {
        config: {
          providers: vi.fn().mockResolvedValue({ data: { providers: [] } }),
        },
        provider: { list: vi.fn() },
      },
      directory: "/project",
    } as unknown as PluginInput

    await expect(getConfig(input)).rejects.toThrow("No OpenCode models found.")
  })
})
