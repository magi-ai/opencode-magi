export type * from "./index.generated"

import type { Requester, Sdk } from "./index.generated"
import { isObject } from "@/utils"
import { getSdk } from "./index.generated"

export type ExpectNode<T> = T extends { nodes: infer U }
  ? U extends Array<infer V>
    ? NonNullable<V>
    : NonNullable<U>
  : ExpectNode<T[keyof T]>

interface Connection {
  nodes?: null | unknown[]
  pageInfo?: null | {
    endCursor?: null | string
    hasNextPage?: boolean | null
  }
}

type BoundSdk = {
  [K in keyof Sdk]: Sdk[K] extends (
    variables: infer Variables,
    options?: infer Options,
  ) => infer Result
    ? (this: void, variables: Variables, options?: Options) => Result
    : never
}

type PageableSdk = {
  [K in keyof BoundSdk]: Parameters<BoundSdk[K]>[0] extends { cursor: unknown }
    ? BoundSdk[K]
    : never
}[keyof BoundSdk]

type PaginateParams<T extends PageableSdk> = Omit<
  Parameters<T>[0],
  "cursor"
> & {
  cursor?: null | string
}

function isConnection(value: unknown): value is Connection {
  if (!value || !isObject(value)) return false

  return "nodes" in value && "pageInfo" in value
}

function findConnection(value: unknown): Connection | undefined {
  if (isConnection(value)) return value
  if (!value || !isObject(value)) return undefined

  for (const child of Object.values(value)) {
    const connection = findConnection(child)

    if (connection) return connection
  }

  return undefined
}

export function graphql<T>(
  requester: Requester<T>,
): BoundSdk & {
  paginate: <T extends PageableSdk>(
    req: T,
    params: PaginateParams<T>,
  ) => Promise<Awaited<ReturnType<T>>>
} {
  const sdk = getSdk(requester)
  const bound = Object.fromEntries(
    Object.entries(sdk).map(([key, req]) => [key, req.bind(sdk)]),
  ) as BoundSdk

  async function paginate<T extends PageableSdk>(
    req: T,
    params: PaginateParams<T>,
  ): Promise<Awaited<ReturnType<T>>> {
    let cursor = params.cursor ?? null
    let result: Awaited<ReturnType<T>> | undefined

    for (;;) {
      const page = (await req({
        ...params,
        cursor,
      })) as Awaited<ReturnType<T>>
      const connection = findConnection(page)

      if (!connection) return page

      if (!result) {
        result = page
      } else {
        const target = findConnection(result)

        target?.nodes?.push(...(connection.nodes ?? []))
      }

      if (!connection.pageInfo?.hasNextPage) return result

      cursor = connection.pageInfo.endCursor ?? null

      if (!cursor) throw new Error("GraphQL page was truncated")
    }
  }

  return { ...bound, paginate }
}

export type Graphql = ReturnType<typeof graphql>
