import type { Dict } from "./index.type"
import { filterEmpty } from "./array"

export function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

export function split(value: string): string[] {
  return filterEmpty(value.split(/[\s,]+/))
}

export function toTitleCase(value: string): string {
  return value
    .replace(/([A-Z])/g, " $1")
    .replace(/[_-](.)/g, (_, val) => ` ${val.toUpperCase()}`)
    .replace(/^./, (str) => str.toUpperCase())
    .trim()
}

export function command(
  ...values: (false | null | number | string | undefined)[]
): string {
  return filterEmpty(values).join(" ")
}

export const marker = {
  parse<T extends Dict>(body: string): T[] {
    const matchAll = body.matchAll(/<!--\s*opencode-magi\s+([^>]*)-->/g)

    return [...matchAll].map((match) =>
      Object.fromEntries(
        match[1]
          ?.trim()
          .split(/\s+/)
          .flatMap((part) => {
            const [key, ...rest] = part.split("=")

            if (!key || !rest.length) return []

            return [[key, rest.join("=")]]
          }) ?? [],
      ),
    ) as T[]
  },
  stringify(...values: Dict[]): string {
    return values
      .map(
        (value) =>
          `<!-- opencode-magi ${Object.entries(value)
            .map(([key, value]) => `${key}=${value}`)
            .join(" ")} -->`,
      )
      .join("\n")
  },
}
