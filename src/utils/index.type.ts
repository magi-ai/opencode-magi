export type Primitive =
  | bigint
  | boolean
  | null
  | number
  | string
  | symbol
  | undefined

export interface Dict<Y = any> {
  [key: string]: Y
}

export type DeepPartial<Y> = Y extends any[] | Date | Function | Primitive
  ? Y
  : {
      [P in keyof Y]?: DeepPartial<Y[P]>
    }
