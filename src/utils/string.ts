export function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}
