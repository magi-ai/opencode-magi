import type { PluginInput } from "@/utils"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, vi } from "vitest"
import { test } from "#/fixtures/magi"
import { CONFIG_PATH } from "@/constant"
import { getConfig, resolvePermissions } from "./resolve"

const mocks = vi.hoisted(() => ({
  getModels: vi.fn(),
}))

vi.mock(import("@/utils"), async (importOriginal) => ({
  ...(await importOriginal()),
  getModels: mocks.getModels,
}))

const globalConfigPath = CONFIG_PATH.GLOBAL

function createInput(directory: string): PluginInput {
  return { directory } as PluginInput
}

async function writeConfig(path: string, config: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(config))
}

describe("resolve", () => {
  beforeEach(() => {
    mocks.getModels.mockReset().mockResolvedValue(["provider/model"])
  })

  afterEach(() => {
    CONFIG_PATH.GLOBAL = globalConfigPath
  })

  describe("resolvePermissions", () => {
    test("returns undefined when permissions are omitted", () => {
      expect(resolvePermissions()).toBeUndefined()
    })

    test("expands a shared permission action", () => {
      expect(resolvePermissions("allow")).toStrictEqual(
        [
          "read",
          "edit",
          "glob",
          "grep",
          "bash",
          "task",
          "skill",
          "lsp",
          "webfetch",
          "websearch",
          "external_directory",
          "doom_loop",
        ].map((permission) => ({
          action: "allow",
          pattern: "*",
          permission,
        })),
      )
    })

    test("flattens permission actions and pattern rules", () => {
      expect(
        resolvePermissions({
          bash: {
            "*": "deny",
            "git status*": "allow",
          },
          read: "ask",
        }),
      ).toStrictEqual([
        { action: "deny", pattern: "*", permission: "bash" },
        { action: "allow", pattern: "git status*", permission: "bash" },
        { action: "ask", pattern: "*", permission: "read" },
      ])
    })
  })

  describe("getConfig", () => {
    test("merges global and project configs", async ({
      temporaryDirectory,
    }) => {
      const projectPath = join(temporaryDirectory, CONFIG_PATH.PROJECT)

      CONFIG_PATH.GLOBAL = join(temporaryDirectory, "global.json")
      await writeConfig(CONFIG_PATH.GLOBAL, {
        github: {
          host: "git.example.com",
          owner: "global-owner",
          repo: "global-repo",
        },
        language: "fr",
      })
      await writeConfig(projectPath, {
        github: {
          owner: "project-owner",
          repo: "project-repo",
        },
        language: "ja",
      })

      const config = await getConfig(createInput(temporaryDirectory))

      expect(config.language).toBe("ja")
      expect(config.github).toMatchObject({
        host: "git.example.com",
        owner: "project-owner",
        repo: "project-repo",
        retryApiAttempts: 3,
        url: "https://git.example.com/project-owner/project-repo",
      })
      expect(config.review.reviewers).toBeUndefined()
      expect(config.merge.editor).toBeUndefined()
      expect(config.triage.voters).toBeUndefined()
      expect(config.triage.creator).toBeUndefined()
    })

    test("resolves agents, references, permissions, accounts, and models", async ({
      temporaryDirectory,
    }) => {
      CONFIG_PATH.GLOBAL = join(temporaryDirectory, "global.json")
      mocks.getModels.mockResolvedValue(["provider/string", "provider/object"])
      await writeConfig(join(temporaryDirectory, CONFIG_PATH.PROJECT), {
        account: "root-account",
        agents: {
          permissions: {
            bash: { "git *": "ask" },
            read: "allow",
          },
          refs: {
            shared: {
              account: "ref-account",
              model: ["missing", { id: "provider/object", variant: "high" }],
              permissions: { read: "deny" },
              persona: "shared persona",
            },
          },
        },
        github: { owner: "magi-ai", repo: "opencode-magi" },
        merge: {
          editor: {
            author: { email: "editor@example.com", name: "Editor" },
            model: { id: "provider/object", variant: "high" },
            permissions: { edit: "deny" },
          },
        },
        review: {
          reviewers: [
            { id: "", ref: "shared" },
            { id: "array-string", model: ["provider/string"] },
            {
              account: "explicit-account",
              id: "array-object",
              model: ["missing", { id: "provider/object" }],
            },
            { id: "array-missing", model: ["missing"] },
            { id: "string-valid", model: "provider/string" },
            { id: "string-missing", model: "missing" },
            { id: "object-valid", model: { id: "provider/object" } },
            { id: "object-missing", model: { id: "missing" } },
            { id: "model-omitted", ref: "unknown" },
          ],
        },
        triage: {
          creator: {
            author: { email: "creator@example.com", name: "Creator" },
            model: "provider/string",
            permissions: { edit: "deny" },
          },
          voters: [
            { id: "", model: "provider/string" },
            { id: "voter-explicit", model: { id: "provider/object" } },
          ],
        },
      })

      const config = await getConfig(createInput(temporaryDirectory))

      expect(
        config.review.reviewers?.map(({ account, id, model }) => ({
          account,
          id,
          model,
        })),
      ).toStrictEqual([
        {
          account: "ref-account",
          id: "reviewer-1",
          model: { id: "provider/object", variant: "high" },
        },
        {
          account: "root-account",
          id: "array-string",
          model: { id: "provider/string" },
        },
        {
          account: "explicit-account",
          id: "array-object",
          model: { id: "provider/object" },
        },
        { account: "root-account", id: "array-missing", model: undefined },
        {
          account: "root-account",
          id: "string-valid",
          model: { id: "provider/string" },
        },
        { account: "root-account", id: "string-missing", model: undefined },
        {
          account: "root-account",
          id: "object-valid",
          model: { id: "provider/object" },
        },
        { account: "root-account", id: "object-missing", model: undefined },
        { account: "root-account", id: "model-omitted", model: undefined },
      ])
      expect(config.review.reviewers?.[0]?.permissions).toMatchObject({
        bash: { "git *": "ask" },
        read: "deny",
      })
      expect(config.review.reviewers?.[0]?.persona).toBe("shared persona")
      expect(config.merge.editor).toMatchObject({
        account: "root-account",
        model: { id: "provider/object", variant: "high" },
        permissions: {
          bash: expect.objectContaining({ "pnpm *": "allow" }),
          edit: "deny",
          read: "allow",
        },
      })
      expect(
        config.triage.voters?.map(({ account, id, model }) => ({
          account,
          id,
          model,
        })),
      ).toStrictEqual([
        {
          account: "root-account",
          id: "voter-1",
          model: { id: "provider/string" },
        },
        {
          account: "root-account",
          id: "voter-explicit",
          model: { id: "provider/object" },
        },
      ])
      expect(config.triage.creator).toMatchObject({
        account: "root-account",
        model: { id: "provider/string" },
        permissions: {
          bash: expect.objectContaining({ "pnpm *": "allow" }),
          edit: "deny",
          read: "allow",
        },
      })
    })

    test("uses scalar base permissions and default editor permissions", async ({
      temporaryDirectory,
    }) => {
      CONFIG_PATH.GLOBAL = join(temporaryDirectory, "global.json")
      await writeConfig(CONFIG_PATH.GLOBAL, {
        agents: { permissions: "ask" },
        github: { owner: "magi-ai", repo: "opencode-magi" },
        merge: {
          editor: {
            author: { email: "editor@example.com", name: "Editor" },
            model: "provider/model",
          },
        },
        review: {
          reviewers: [
            {
              id: "reviewer",
              model: "provider/model",
              permissions: { read: "deny" },
            },
          ],
        },
        triage: {
          creator: {
            author: { email: "creator@example.com", name: "Creator" },
            model: "provider/model",
          },
          voters: [{ id: "voter", model: "provider/model" }],
        },
      })

      const config = await getConfig(createInput(temporaryDirectory))

      expect(config.review.reviewers?.[0]?.permissions).toStrictEqual({
        read: "deny",
      })
      expect(config.triage.voters?.[0]?.permissions).toBe("ask")
      expect(config.merge.editor?.permissions).toMatchObject({
        edit: "allow",
      })
      expect(config.triage.creator?.permissions).toMatchObject({
        edit: "allow",
      })
    })

    test("rejects an empty model list", async ({ temporaryDirectory }) => {
      CONFIG_PATH.GLOBAL = join(temporaryDirectory, "global.json")
      mocks.getModels.mockResolvedValue([])

      await expect(getConfig(createInput(temporaryDirectory))).rejects.toThrow(
        "No OpenCode models found.",
      )
    })

    test("rejects missing config files", async ({ temporaryDirectory }) => {
      CONFIG_PATH.GLOBAL = join(temporaryDirectory, "global.json")

      await expect(getConfig(createInput(temporaryDirectory))).rejects.toThrow(
        `No Magi config found. Expected ${CONFIG_PATH.GLOBAL} or ${join(temporaryDirectory, CONFIG_PATH.PROJECT)}.`,
      )
    })

    test("rethrows malformed config JSON", async ({ temporaryDirectory }) => {
      CONFIG_PATH.GLOBAL = join(temporaryDirectory, "global.json")
      await mkdir(dirname(CONFIG_PATH.GLOBAL), { recursive: true })
      await writeFile(CONFIG_PATH.GLOBAL, "not json")

      await expect(
        getConfig(createInput(temporaryDirectory)),
      ).rejects.toBeInstanceOf(SyntaxError)
    })

    test("rejects config values that are not objects", async ({
      temporaryDirectory,
    }) => {
      CONFIG_PATH.GLOBAL = join(temporaryDirectory, "global.json")
      await writeConfig(CONFIG_PATH.GLOBAL, [])

      await expect(getConfig(createInput(temporaryDirectory))).rejects.toThrow(
        `Config must be a JSON object: ${CONFIG_PATH.GLOBAL}`,
      )
    })
  })
})
