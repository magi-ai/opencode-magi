import type { PluginInput } from "@/utils"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({ readFile: vi.fn() }))

vi.mock("node:fs/promises", () => ({ readFile: mocks.readFile }))

import { getConfig } from "./resolve"

function input(): PluginInput {
  return {
    client: {
      config: {
        providers: () =>
          Promise.resolve({
            data: { providers: [{ id: "test", models: { model: {} } }] },
          }),
      },
    },
    directory: "/project",
  } as unknown as PluginInput
}

describe("getConfig", () => {
  beforeEach(() => {
    mocks.readFile.mockImplementation((path: string) => {
      if (path === "/project/.opencode/magi.json")
        return Promise.resolve(
          JSON.stringify({
            account: "account",
            github: { owner: "owner", repo: "repo" },
            merge: {
              editor: {
                account: "editor",
                author: { email: "editor@example.com", name: "Editor" },
                model: "test/model",
              },
            },
            triage: {
              creator: {
                author: { email: "creator@example.com", name: "Creator" },
                model: "test/model",
              },
            },
          }),
        )

      const error = new Error() as NodeJS.ErrnoException

      error.code = "ENOENT"

      return Promise.reject(error)
    })
  })

  afterEach(() => {
    mocks.readFile.mockReset()
  })

  test("applies editing permissions to configured editors and creators", async () => {
    const config = await getConfig(input())

    expect(config.merge.editor?.permissions).toMatchObject({
      bash: { "git add*": "allow", "pnpm *": "allow" },
      edit: "allow",
    })
    expect(config.triage.creator?.permissions).toMatchObject({
      bash: { "git add*": "allow", "pnpm *": "allow" },
      edit: "allow",
    })
  })

  test("allows configurations without an editor or creator", async () => {
    mocks.readFile.mockImplementation((path: string) => {
      if (path === "/project/.opencode/magi.json")
        return Promise.resolve(
          JSON.stringify({
            account: "account",
            github: { owner: "owner", repo: "repo" },
          }),
        )

      const error = new Error() as NodeJS.ErrnoException

      error.code = "ENOENT"

      return Promise.reject(error)
    })

    const config = await getConfig(input())

    expect(config.merge.editor).toBeUndefined()
    expect(config.triage.creator).toBeUndefined()
  })
})
