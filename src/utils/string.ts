import { filterEmpty } from "./array"

export function quote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`
}

export function split(value: string) {
  return filterEmpty(value.split(/[\s,]+/))
}
