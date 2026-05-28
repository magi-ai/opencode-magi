export function filterDuplicates<T>(value: T[]): T[] {
  return [...new Set(value)]
}

export function filterEmpty<Y>(array: Y[]): Exclude<Y, null | undefined>[] {
  return array.filter((value) => value != null) as Exclude<
    Y,
    null | undefined
  >[]
}
