import type { Dict } from "./index.type"
import { filterEmpty } from "./array"

export function quote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`
}

export function split(value: string) {
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
  parse<T extends Dict>(body: string): T {
    const match = body.match(/<!--\s*opencode-magi\s+([^>]*)-->/)

    if (!match) return {} as T

    return Object.fromEntries(
      match[1]
        ?.trim()
        .split(/\s+/)
        .map((part) => part.split("=")) ?? [],
    )
  },
  stringify(values: Dict) {
    return `<!-- opencode-magi ${Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join(" ")} -->`
  },
}
