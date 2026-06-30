import type { Dict } from "./index.type"
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

export function filterObject<T extends Dict, K extends Dict>(
  obj: T,
  func: (key: keyof T, value: T[keyof T], obj: T) => boolean,
): K {
  const result: Dict = {}

  Object.entries(obj).forEach(([key, value]) => {
    if (func(key, value, obj)) result[key] = value
  })

  return result as K
}

export function omitNullish<T extends Dict>(
  obj: T,
): Required<{ [K in keyof T]: Exclude<T[K], null | undefined> }> {
  return filterObject(obj, (_, val) => val != null)
}
