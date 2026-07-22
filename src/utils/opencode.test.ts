import type { Provider } from "@opencode-ai/sdk/v2"
import type { PluginInput } from "./opencode"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { beforeEach, describe, expect, test, vi } from "vitest"
import { getModels } from "./opencode"

const { createExecMock, execMock } = vi.hoisted(() => {
  const execMock = vi.fn()

  return { createExecMock: vi.fn(() => execMock), execMock }
})

vi.mock("./exec", () => ({ createExec: createExecMock }))

function createInput(): PluginInput {
  return {
    $: vi.fn() as unknown as PluginInput["$"],
    client: createOpencodeClient({ baseUrl: "http://localhost" }),
    directory: "/repo",
    experimental_workspace: { register: vi.fn() },
    project: { id: "project", time: { created: 0 }, worktree: "/repo" },
    serverUrl: new URL("http://localhost"),
    worktree: "/repo",
  }
}

function createProvider(id: string, modelIds: string[]): Provider {
  return {
    env: [],
    id,
    models: Object.fromEntries(
      modelIds.map((modelId) => [modelId, {} as Provider["models"][string]]),
    ),
    name: id,
    options: {},
    source: "config",
  }
}

function createRequest(): Request {
  return new Request("http://localhost")
}

describe("getModels", () => {
  beforeEach(() => {
    createExecMock.mockClear()
    execMock.mockReset()
  })

  test("returns configured provider models", async () => {
    const input = createInput()
    const providers = vi
      .spyOn(input.client.config, "providers")
      .mockResolvedValue({
        data: {
          default: {},
          providers: [
            createProvider("anthropic", ["opus", "sonnet"]),
            createProvider("", ["local"]),
          ],
        },
        error: undefined,
        request: createRequest(),
        response: new Response(),
      })
    const list = vi
      .spyOn(input.client.provider, "list")
      .mockRejectedValue(new Error("unexpected provider list call"))

    await expect(getModels(input)).resolves.toStrictEqual([
      "anthropic/opus",
      "anthropic/sonnet",
      "local",
    ])
    expect(providers).toHaveBeenCalledExactlyOnceWith({ directory: "/repo" })
    expect(list).not.toHaveBeenCalled()
    expect(createExecMock).not.toHaveBeenCalled()
  })

  test("falls back to the provider list endpoint", async () => {
    const input = createInput()

    vi.spyOn(input.client.config, "providers").mockRejectedValue(
      new Error("unsupported"),
    )

    const list = vi.spyOn(input.client.provider, "list").mockResolvedValue({
      data: {
        all: [createProvider("openai", ["gpt"])],
        connected: [],
        default: {},
      },
      error: undefined,
      request: createRequest(),
      response: new Response(),
    })

    await expect(getModels(input)).resolves.toStrictEqual(["openai/gpt"])
    expect(list).toHaveBeenCalledExactlyOnceWith({ directory: "/repo" })
    expect(createExecMock).not.toHaveBeenCalled()
  })

  test("falls back to the CLI and filters non-model output", async () => {
    const input = createInput()

    vi.spyOn(input.client.config, "providers").mockResolvedValue({
      data: { default: {}, providers: [] },
      error: undefined,
      request: createRequest(),
      response: new Response(),
    })
    vi.spyOn(input.client.provider, "list").mockRejectedValue(
      new Error("unexpected provider list call"),
    )
    execMock.mockResolvedValue("anthropic/sonnet\nheading\nopenai/gpt")

    await expect(getModels(input)).resolves.toStrictEqual([
      "anthropic/sonnet",
      "openai/gpt",
    ])
    expect(createExecMock).toHaveBeenCalledExactlyOnceWith("/repo")
    expect(execMock).toHaveBeenCalledExactlyOnceWith("opencode models")
  })

  test("returns an empty array when provider data is unavailable and the CLI fails", async () => {
    const input = createInput()

    vi.spyOn(input.client.config, "providers").mockResolvedValue({
      data: undefined,
      error: { data: { message: "unavailable" }, name: "BadRequest" },
      request: createRequest(),
      response: new Response(),
    })
    vi.spyOn(input.client.provider, "list").mockRejectedValue(
      new Error("unexpected provider list call"),
    )
    execMock.mockRejectedValue(new Error("CLI unavailable"))

    await expect(getModels(input)).resolves.toStrictEqual([])
  })
})
