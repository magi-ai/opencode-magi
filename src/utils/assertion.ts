export function isNumber(value: any): value is number {
  return typeof value === "number"
}

export function isString(value: any): value is string {
  return Object.prototype.toString.call(value) === "[object String]"
}

export function isBoolean(value: any): value is boolean {
  return typeof value === "boolean"
}

export function isUndefined(value: any): value is undefined {
  return typeof value === "undefined"
}

export function isNull(value: any): value is null {
  return value === null
}

export function isRegExp(value: any): value is RegExp {
  return value instanceof RegExp
}

export function isObject<T extends object>(value: any): value is T {
  return (
    value != null &&
    (typeof value === "object" || typeof value === "function") &&
    !isArray(value)
  )
}

export function isDate(value: any): value is Date {
  return value instanceof Date
}
export function isArray<T extends any[]>(value: any): value is T {
  return Array.isArray(value)
}

export function isEmpty(value: any): boolean {
  return !isArray(value) || !value.length || value.every((v) => v == null)
}

export function isEmptyObject(value: any): boolean {
  return isObject(value) && !Object.keys(value).length
}

export function isFunction<T extends Function = Function>(
  value: any,
): value is T {
  return typeof value === "function"
}
