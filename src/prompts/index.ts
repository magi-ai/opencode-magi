import type { Config } from "@/config"
import type { Magi } from "@/magi"
import type { Dict } from "@/utils"
import Ajv from "ajv"
import { readFile } from "fs/promises"
import { join } from "path"
import { isString, isUndefined } from "@/utils"

export type PromptTag = [string, string] | string

export class Prompt {
  constructor(
    private magi: Magi,
    private config: Config.Root,
    private pathname: string,
    private validateSchema: Dict | undefined,
  ) {}

  static async init(
    magi: Magi,
    config: Config.Root,
    dir: string,
  ): Promise<Prompt> {
    const url = new URL(dir, import.meta.url)

    let validateSchema: Dict | undefined

    try {
      validateSchema = JSON.parse(
        await readFile(join(url.pathname, "validate.json"), "utf-8"),
      )
    } catch {}

    return new Prompt(magi, config, url.pathname, validateSchema)
  }

  public async create(
    taskPath: string | undefined,
    tags: PromptTag[],
    values: { [key: string]: string },
  ): Promise<string> {
    const [task, ...rest] = await Promise.all([
      readFile(
        taskPath ? this.magi.getPath(taskPath) : join(this.pathname, "task.md"),
        "utf-8",
      ),
      ...tags.map(async (tag) => {
        if (isString(tag)) {
          const path = join(this.pathname, `${tag.replaceAll("_", "-")}.md`)
          const content = await readFile(path, "utf-8")

          return { content, tag }
        } else {
          return { content: tag[1], tag: tag[0] }
        }
      }),
    ])
    const content = [
      `<task>\n${task}\n</task>`,
      `<language>\n${this.config.language}\n</language>`,
      ...rest.map(({ content, tag }) => `<${tag}>\n${content}\n</${tag}>`),
    ].join("\n\n")

    return Object.entries(values).reduce(
      (prev, [key, value]) => prev.replaceAll(`{${key}}`, value),
      content,
    )
  }

  public async repair(e?: unknown): Promise<string> {
    const instructions = [
      "Your previous output failed validation. Regenerate the result.",
      !isUndefined(e)
        ? `Validation error: ${e instanceof Error ? e.message : "Invalid output."}`
        : undefined,
      "Return only a JSON object matching the output contract below. Do not include analysis, explanation, apologies, markdown, or any text before or after the JSON object.",
    ]
      .filter((instruction) => !isUndefined(instruction))
      .join("\n\n")

    try {
      const outputContract = await readFile(
        join(this.pathname, "output-contract.md"),
        "utf-8",
      )

      return [
        instructions,
        `<output_contract>\n${outputContract}\n</output_contract>`,
      ].join("\n\n")
    } catch {
      return instructions
    }
  }

  public parse(content: string): Dict {
    const trimmed = content.trim()

    try {
      return JSON.parse(trimmed)
    } catch {
      const candidates: string[] = []

      for (const match of trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
        const candidate = match.at(1)?.trim()

        if (candidate) candidates.unshift(candidate)
      }

      for (const match of trimmed.matchAll(/\{[\s\S]*?\}/g)) {
        const candidate = match.at(0)

        if (candidate) candidates.unshift(candidate)
      }

      for (const candidate of candidates)
        try {
          return JSON.parse(candidate)
        } catch {}
    }

    return {}
  }

  public validate<T>(content: unknown): content is T {
    if (!this.validateSchema) return true

    const validate = new Ajv({ allErrors: true }).compile(this.validateSchema)

    return Boolean(validate(content))
  }
}
