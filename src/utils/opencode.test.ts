import type { Plugin } from "@opencode/plugin"
import type { PluginInput } from "./opencode"
import { getModels } from "./opencode"

const { createExecMock, execMock } = vi.hoisted(() => {
  const execMock = vi.fn()

  return { createExecMock: vi.fn(() => execMock), execMock }
})

vi.mock("./exec", () => ({ createExec: createExecMock }))

function createInput(list: ReturnType<typeof vi.fn>): PluginInput {
  return {
    client: { model: { list } } as unknown as Plugin.Context,
    directory: "/repo",
  }
}

describe("getModels", () => {
  beforeEach(() => {
    createExecMock.mockClear()
    execMock.mockReset()
  })

  test("returns models from the v2 catalog", async () => {
    const list = vi.fn().mockResolvedValue({
      data: [
        { id: "sonnet", providerID: "anthropic" },
        { id: "openai/gpt", providerID: "openrouter" },
      ],
    })

    await expect(getModels(createInput(list))).resolves.toStrictEqual([
      "anthropic/sonnet",
      "openrouter/openai/gpt",
    ])
    expect(list).toHaveBeenCalledExactlyOnceWith({
      location: { directory: "/repo" },
    })
    expect(createExecMock).not.toHaveBeenCalled()
  })

  test("falls back to the CLI and filters non-model output", async () => {
    const list = vi.fn().mockResolvedValue({ data: [] })

    execMock.mockResolvedValue("anthropic/sonnet\nheading\nopenai/gpt")

    await expect(getModels(createInput(list))).resolves.toStrictEqual([
      "anthropic/sonnet",
      "openai/gpt",
    ])
    expect(createExecMock).toHaveBeenCalledExactlyOnceWith("/repo")
    expect(execMock).toHaveBeenCalledExactlyOnceWith("opencode models")
  })

  test("returns an empty array when the catalog and CLI fail", async () => {
    const list = vi.fn().mockRejectedValue(new Error("unavailable"))

    execMock.mockRejectedValue(new Error("CLI unavailable"))

    await expect(getModels(createInput(list))).resolves.toStrictEqual([])
  })
})
