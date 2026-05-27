import { isObject } from "./assertion"

export function merge<T extends object>(base: any, override: any): T {
  const merged = { ...base }

  for (const [key, value] of Object.entries(override)) {
    const existing = merged[key]

    merged[key] =
      isObject(existing) && isObject(value) ? merge(existing, value) : value
  }

  return merged
}
