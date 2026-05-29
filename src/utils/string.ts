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
