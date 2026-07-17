import type { PluginInput } from "./opencode"
import { afterEach, describe, expect, test, vi } from "vitest"
import { createExec } from "./exec"
import { getModels } from "./opencode"

vi.mock("./exec", () => ({ createExec: vi.fn() }))

function createInput(
  providers: ReturnType<typeof vi.fn>,
  list: ReturnType<typeof vi.fn>,
): PluginInput {
  return {
    client: { config: { providers }, provider: { list } },
    directory: "/repo",
  } as unknown as PluginInput
}

describe("getModels", () => {
  afterEach(() => vi.resetAllMocks())

  test("returns models from the server API without running the CLI", async () => {
    const providers = vi.fn().mockResolvedValue({
      data: { providers: [{ id: "openai", models: { "gpt-5.6": {} } }] },
    })
    const list = vi.fn()

    await expect(
      getModels(createInput(providers, list)),
    ).resolves.toStrictEqual(["openai/gpt-5.6"])
    expect(list).not.toHaveBeenCalled()
    expect(createExec).not.toHaveBeenCalled()
  })

  test("falls back to CLI models when the config API returns none", async () => {
    const run = vi
      .fn()
      .mockResolvedValue("openai/gpt-5.6\nnot-a-model\nanthropic/claude")

    vi.mocked(createExec).mockReturnValue(run)

    await expect(
      getModels(
        createInput(
          vi.fn().mockResolvedValue({ data: { providers: [] } }),
          vi.fn(),
        ),
      ),
    ).resolves.toStrictEqual(["openai/gpt-5.6", "anthropic/claude"])
    expect(createExec).toHaveBeenCalledWith("/repo")
    expect(run).toHaveBeenCalledWith("opencode models")
  })

  test("falls back to CLI models when the provider API returns none", async () => {
    const run = vi.fn().mockResolvedValue("openai/gpt-5.6")

    vi.mocked(createExec).mockReturnValue(run)

    const list = vi.fn().mockResolvedValue({ data: { all: [] } })

    await expect(
      getModels(
        createInput(vi.fn().mockRejectedValue(new Error("not found")), list),
      ),
    ).resolves.toStrictEqual(["openai/gpt-5.6"])
    expect(list).toHaveBeenCalledWith({ directory: "/repo" })
    expect(run).toHaveBeenCalledWith("opencode models")
  })

  test("returns no models when the CLI fallback fails", async () => {
    vi.mocked(createExec).mockReturnValue(
      vi.fn().mockRejectedValue(new Error()),
    )

    await expect(
      getModels(
        createInput(
          vi.fn().mockResolvedValue({ data: { providers: [] } }),
          vi.fn(),
        ),
      ),
    ).resolves.toStrictEqual([])
  })
})
