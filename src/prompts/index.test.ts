import type { Config } from "@/config"
import type { Magi } from "@/magi"
import type { Dict } from "@/utils"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { afterEach, describe, expect, test, vi } from "vitest"
import { DEFAULT_CONFIG } from "@/constant"
import { Prompt } from "."

interface PromptFixture {
  config: Config.Root
  getPath: ReturnType<typeof vi.fn<(value: string) => string>>
  prompt: Prompt
}

const temporaryDirectories: string[] = []

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "opencode-magi-prompt-test-"))

  temporaryDirectories.push(directory)

  return directory
}

function createPrompt(pathname: string, validateSchema?: Dict): PromptFixture {
  const config = structuredClone(DEFAULT_CONFIG)
  const getPath = vi.fn<(value: string) => string>((value) => value)
  const magi = { getPath } as unknown as Magi

  config.language = "ja"

  return {
    config,
    getPath,
    prompt: new Prompt(magi, config, pathname, validateSchema),
  }
}

describe("Prompt", () => {
  afterEach(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { force: true, recursive: true })),
    )
  })

  describe("constructor", () => {
    test("creates a prompt", async () => {
      const directory = await createTemporaryDirectory()
      const { prompt } = createPrompt(directory)

      expect(prompt).toBeInstanceOf(Prompt)
    })
  })

  describe("init", () => {
    test("loads the validation schema", async () => {
      const directory = await createTemporaryDirectory()
      const config = structuredClone(DEFAULT_CONFIG)
      const magi = {} as Magi

      await writeFile(
        join(directory, "validate.json"),
        JSON.stringify({
          additionalProperties: false,
          properties: { verdict: { type: "string" } },
          required: ["verdict"],
          type: "object",
        }),
      )

      const prompt = await Prompt.init(
        magi,
        config,
        pathToFileURL(`${directory}/`).href,
      )

      expect(prompt).toBeInstanceOf(Prompt)
      expect(prompt.validate({ verdict: "approve" })).toBeTruthy()
      expect(prompt.validate({ extra: true })).toBeFalsy()
    })

    test("ignores a missing validation schema", async () => {
      const directory = await createTemporaryDirectory()
      const prompt = await Prompt.init(
        {} as Magi,
        structuredClone(DEFAULT_CONFIG),
        pathToFileURL(`${directory}/`).href,
      )

      expect(prompt.validate({ any: "value" })).toBeTruthy()
    })

    test("ignores malformed validation JSON", async () => {
      const directory = await createTemporaryDirectory()

      await writeFile(join(directory, "validate.json"), "not json")

      const prompt = await Prompt.init(
        {} as Magi,
        structuredClone(DEFAULT_CONFIG),
        pathToFileURL(`${directory}/`).href,
      )

      expect(prompt.validate({ any: "value" })).toBeTruthy()
    })
  })

  describe("create", () => {
    test("composes the default task, language, and tags", async () => {
      const directory = await createTemporaryDirectory()
      const { getPath, prompt } = createPrompt(directory)

      await writeFile(
        join(directory, "task.md"),
        "Review {target} and {target}.",
      )
      await writeFile(
        join(directory, "review-guidelines.md"),
        "Follow {guideline}.",
      )

      await expect(
        prompt.create(
          undefined,
          ["review_guidelines", ["context", "Context for {target}."]],
          {
            guideline: "the rules",
            target: "the pull request",
          },
        ),
      ).resolves.toBe(
        [
          "<task>\nReview the pull request and the pull request.\n</task>",
          "<language>\nja\n</language>",
          "<review_guidelines>\nFollow the rules.\n</review_guidelines>",
          "<context>\nContext for the pull request.\n</context>",
        ].join("\n\n"),
      )
      expect(getPath).not.toHaveBeenCalled()
    })

    test("resolves a custom task through Magi", async () => {
      const directory = await createTemporaryDirectory()
      const taskPath = join(directory, "custom-task.md")
      const { getPath, prompt } = createPrompt(directory)

      getPath.mockReturnValue(taskPath)
      await writeFile(taskPath, "Custom task")

      await expect(prompt.create("custom/task.md", [], {})).resolves.toBe(
        "<task>\nCustom task\n</task>\n\n<language>\nja\n</language>",
      )
      expect(getPath).toHaveBeenCalledWith("custom/task.md")
    })
  })

  describe("repair", () => {
    test("includes the output contract", async () => {
      const directory = await createTemporaryDirectory()
      const { prompt } = createPrompt(directory)

      await writeFile(
        join(directory, "output-contract.md"),
        "Return a verdict.",
      )

      await expect(prompt.repair()).resolves.toBe(
        [
          "Your previous output failed validation. Regenerate the result.",
          "Return only a JSON object matching the output contract below. Do not include analysis, explanation, apologies, markdown, or any text before or after the JSON object.",
          "<output_contract>\nReturn a verdict.\n</output_contract>",
        ].join("\n\n"),
      )
    })

    test("includes an Error message without an output contract", async () => {
      const directory = await createTemporaryDirectory()
      const { prompt } = createPrompt(directory)

      await expect(prompt.repair(new Error("Missing verdict"))).resolves.toBe(
        [
          "Your previous output failed validation. Regenerate the result.",
          "Validation error: Missing verdict",
          "Return only a JSON object matching the output contract below. Do not include analysis, explanation, apologies, markdown, or any text before or after the JSON object.",
        ].join("\n\n"),
      )
    })

    test("describes a non-Error validation failure", async () => {
      const directory = await createTemporaryDirectory()
      const { prompt } = createPrompt(directory)

      await expect(prompt.repair("invalid")).resolves.toContain(
        "Validation error: Invalid output.",
      )
    })
  })

  describe("parse", () => {
    test("parses a JSON document", async () => {
      const directory = await createTemporaryDirectory()
      const { prompt } = createPrompt(directory)

      expect(prompt.parse('  {"verdict":"approve"}\n')).toStrictEqual({
        verdict: "approve",
      })
    })

    test("parses the last valid fenced candidate", async () => {
      const directory = await createTemporaryDirectory()
      const { prompt } = createPrompt(directory)

      expect(prompt.parse('```json\n"valid"\n```\n```json\ninvalid\n```')).toBe(
        "valid",
      )
    })

    test("parses an embedded object after invalid candidates", async () => {
      const directory = await createTemporaryDirectory()
      const { prompt } = createPrompt(directory)

      expect(
        prompt.parse('prefix {"valid":true} suffix {invalid}'),
      ).toStrictEqual({ valid: true })
    })

    test("returns an empty object when no candidate is valid", async () => {
      const directory = await createTemporaryDirectory()
      const { prompt } = createPrompt(directory)

      expect(prompt.parse("```json\n\n```\n{invalid}")).toStrictEqual({})
    })

    test("ignores a match without a candidate", async () => {
      const directory = await createTemporaryDirectory()
      const { prompt } = createPrompt(directory)
      const emptyMatch = [undefined] as unknown as RegExpMatchArray
      const trimmed = {
        matchAll(regexp: RegExp): IterableIterator<RegExpMatchArray> {
          return regexp.source.startsWith("\\{")
            ? [emptyMatch].values()
            : [].values()
        },
        toString(): string {
          return "invalid"
        },
      }
      const content = { trim: () => trimmed } as unknown as string

      expect(prompt.parse(content)).toStrictEqual({})
    })
  })

  describe("validate", () => {
    test("accepts any content without a schema", async () => {
      const directory = await createTemporaryDirectory()
      const { prompt } = createPrompt(directory)

      expect(prompt.validate(undefined)).toBeTruthy()
    })

    test("validates content against the schema", async () => {
      const directory = await createTemporaryDirectory()
      const { prompt } = createPrompt(directory, {
        properties: { value: { type: "number" } },
        required: ["value"],
        type: "object",
      })

      expect(prompt.validate<{ value: number }>({ value: 1 })).toBeTruthy()
      expect(prompt.validate<{ value: number }>({ value: "1" })).toBeFalsy()
    })
  })
})
