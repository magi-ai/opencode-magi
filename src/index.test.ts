import type { Plugin } from "@opencode/plugin"
import type {
  CommandDefinition,
  CommandEditor,
  CommandInvocation,
} from "@opencode/plugin/promise/command"
import type {
  Info,
  ToolContext,
  ToolEditor,
} from "@opencode/plugin/promise/tool"
import { DEFAULT_CONFIG } from "@/constant"
import plugin from "."
import { Magi } from "./magi"

async function setup(): Promise<{
  commands: CommandDefinition[]
  prompt: ReturnType<typeof vi.fn>
  tools: Info[]
}> {
  const commands: CommandDefinition[] = []
  const tools: Info[] = []
  const prompt = vi.fn()
  const context = {
    command: {
      transform: (callback: (editor: CommandEditor) => void): Promise<void> => {
        callback({
          add: (command): void => {
            commands.push(command)
          },
        })

        return Promise.resolve()
      },
    },
    location: { directory: "/repo" },
    options: {},
    session: { prompt },
    tool: {
      transform: (callback: (editor: ToolEditor) => void): Promise<void> => {
        callback({
          add: (tool: Info): void => {
            tools.push(tool)
          },
        } as ToolEditor)

        return Promise.resolve()
      },
    },
  } as unknown as Plugin.Context

  await plugin.setup(context)

  return { commands, prompt, tools }
}

describe("plugin", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  test("loads a v2 definition and registers all Magi commands and tools", async () => {
    expect(plugin.id).toBe("opencode-magi")

    const { commands, tools } = await setup()

    expect(commands.map(({ name }) => name).sort()).toStrictEqual([
      "magi:clear",
      "magi:merge",
      "magi:review",
      "magi:triage",
      "magi:validate",
    ])
    expect(tools.map(({ name }) => name).sort()).toStrictEqual([
      "magi_clear",
      "magi_merge",
      "magi_review",
      "magi_triage",
      "magi_validate",
    ])
    expect(
      tools.find(({ name }) => name === "magi_review")!.input,
    ).toStrictEqual({
      additionalProperties: false,
      properties: { dryRun: { type: "boolean" }, prs: { type: "string" } },
      required: ["prs"],
      type: "object",
    })
  })

  test("submits command arguments and attachments through the v2 prompt API", async () => {
    const { commands, prompt } = await setup()
    const invocation = {
      delivery: "queue",
      prompt: {
        files: [{ uri: "file:///repo/context.md" }],
        text: "123 --language $&",
      },
      sessionID: "session" as CommandInvocation["sessionID"],
    } satisfies CommandInvocation

    await commands
      .find(({ name }) => name === "magi:review")!
      .execute(invocation)

    expect(prompt).toHaveBeenCalledExactlyOnceWith({
      delivery: "queue",
      files: invocation.prompt.files,
      sessionID: "session",
      text: "Call the `magi_review` tool.\nPR: 123 --language $&",
    })
  })

  test("returns structured tool content through a registered v2 tool", async () => {
    vi.spyOn(Magi.prototype, "getConfig").mockResolvedValue(
      structuredClone(DEFAULT_CONFIG),
    )
    vi.spyOn(Magi.prototype, "clear").mockResolvedValue({
      branch: 0,
      output: 0,
      run: 0,
      session: 0,
      skipped: 1,
      worktree: 0,
    })

    const { tools } = await setup()
    const result = await tools
      .find(({ name }) => name === "magi_clear")!
      .execute({}, {} as ToolContext)

    expect(result).toStrictEqual({
      content: [
        "Cleared Magi runs: 0",
        "Skipped active runs: 1",
        "Sessions deleted: 0",
        "Worktrees deleted: 0",
        "Branches deleted: 0",
        "Outputs deleted: 0",
      ].join("\n"),
    })
  })
})
