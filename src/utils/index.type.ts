export type Primitive =
  | bigint
  | boolean
  | null
  | number
  | string
  | symbol
  | undefined

export interface Dict<T = any> {
  [key: string]: T
}

export type DeepPartial<T> = T extends any[] | Date | Function | Primitive
  ? T
  : {
      [P in keyof T]?: DeepPartial<T[P]>
    }

export type DeepNonNullable<T> = T extends Date | Function | Primitive
  ? NonNullable<T>
  : T extends ReadonlyArray<infer U>
    ? DeepNonNullable<NonNullable<U>>[]
    : {
        [P in keyof T]-?: DeepNonNullable<NonNullable<T[P]>>
      }
