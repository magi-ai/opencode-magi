import {
  isArray,
  isBoolean,
  isDate,
  isEmpty,
  isEmptyObject,
  isFunction,
  isNull,
  isNumber,
  isObject,
  isRegExp,
  isString,
  isUndefined,
} from "./assertion"

describe("isNumber", () => {
  test("returns true for numbers", () => {
    expect(isNumber(42)).toBeTruthy()
  })

  test("returns false for non-numbers", () => {
    expect(isNumber("42")).toBeFalsy()
  })
})

describe("isString", () => {
  test("returns true for primitive and boxed strings", () => {
    expect(isString("value")).toBeTruthy()
    expect(isString(Object("value"))).toBeTruthy()
  })

  test("returns false for non-strings", () => {
    expect(isString(42)).toBeFalsy()
  })
})

describe("isBoolean", () => {
  test("returns true for booleans", () => {
    expect(isBoolean(false)).toBeTruthy()
  })

  test("returns false for non-booleans", () => {
    expect(isBoolean(0)).toBeFalsy()
  })
})

describe("isUndefined", () => {
  test("returns true for undefined", () => {
    expect(isUndefined(undefined)).toBeTruthy()
  })

  test("returns false for defined values", () => {
    expect(isUndefined(null)).toBeFalsy()
  })
})

describe("isNull", () => {
  test("returns true for null", () => {
    expect(isNull(null)).toBeTruthy()
  })

  test("returns false for non-null values", () => {
    expect(isNull(undefined)).toBeFalsy()
  })
})

describe("isRegExp", () => {
  test("returns true for regular expressions", () => {
    expect(isRegExp(/value/)).toBeTruthy()
  })

  test("returns false for non-regular expressions", () => {
    expect(isRegExp("value")).toBeFalsy()
  })
})

describe("isObject", () => {
  test("returns true for objects and functions", () => {
    expect(isObject({})).toBeTruthy()
    expect(isObject(() => undefined)).toBeTruthy()
  })

  test("returns false for arrays", () => {
    expect(isObject([])).toBeFalsy()
  })

  test("returns false for null and primitive values", () => {
    expect(isObject(null)).toBeFalsy()
    expect(isObject("value")).toBeFalsy()
  })
})

describe("isDate", () => {
  test("returns true for dates", () => {
    expect(isDate(new Date("2026-01-01T00:00:00Z"))).toBeTruthy()
  })

  test("returns false for date strings", () => {
    expect(isDate("2026-01-01T00:00:00Z")).toBeFalsy()
  })
})

describe("isArray", () => {
  test("returns true for arrays", () => {
    expect(isArray([])).toBeTruthy()
  })

  test("returns false for non-arrays", () => {
    expect(isArray({ length: 0 })).toBeFalsy()
  })
})

describe("isEmpty", () => {
  test("returns true for an empty array", () => {
    expect(isEmpty([])).toBeTruthy()
  })

  test("returns true when every array value is nullish", () => {
    expect(isEmpty([null, undefined])).toBeTruthy()
  })

  test("returns false when an array contains a non-nullish value", () => {
    expect(isEmpty([null, 0])).toBeFalsy()
  })
})

describe("isEmptyObject", () => {
  test("returns true for an object without enumerable properties", () => {
    expect(isEmptyObject({})).toBeTruthy()
  })

  test("returns false for an object with enumerable properties", () => {
    expect(isEmptyObject({ value: undefined })).toBeFalsy()
  })
})

describe("isFunction", () => {
  test("returns true for functions", () => {
    expect(isFunction(() => undefined)).toBeTruthy()
  })

  test("returns false for non-functions", () => {
    expect(isFunction({})).toBeFalsy()
  })
})
