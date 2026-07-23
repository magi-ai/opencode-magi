import type { Requester } from "./index.generated"
import { graphql } from "."
import { MergeQueueStatusDocument } from "./index.generated"

const variables = {
  owner: "magi-ai",
  pr: 123,
  repo: "opencode-magi",
}

describe("graphql", () => {
  test("binds SDK methods and forwards the request options", async () => {
    const response = { repository: null }
    const requester = vi.fn().mockResolvedValue(response)
    const sdk = graphql(
      requester as unknown as Requester<{ requestId: string }>,
    )

    await expect(
      sdk.mergeQueueStatus(variables, { requestId: "request-1" }),
    ).resolves.toBe(response)
    expect(requester).toHaveBeenCalledTimes(1)
    expect(requester).toHaveBeenCalledWith(
      MergeQueueStatusDocument,
      variables,
      { requestId: "request-1" },
    )
  })

  test("returns a response without a connection", async () => {
    const response = { child: 1, decoy: { nodes: [] } }
    const request = vi.fn().mockResolvedValue(response)
    const sdk = graphql(vi.fn() as unknown as Requester)

    await expect(
      sdk.paginate(request as unknown as typeof sdk.closingIssues, variables),
    ).resolves.toBe(response)
    expect(request).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith({ ...variables, cursor: null })
  })

  test("combines connection nodes from every page", async () => {
    const firstPage = {
      ignored: null,
      repository: {
        pullRequest: {
          closingIssuesReferences: {
            nodes: [{ number: 1 }],
            pageInfo: { endCursor: "second", hasNextPage: true },
          },
        },
      },
    }
    const secondPage = {
      repository: {
        pullRequest: {
          closingIssuesReferences: {
            nodes: null,
            pageInfo: { endCursor: "third", hasNextPage: true },
          },
        },
      },
    }
    const thirdPage = {
      repository: {
        pullRequest: {
          closingIssuesReferences: {
            nodes: [{ number: 3 }],
            pageInfo: { endCursor: null, hasNextPage: false },
          },
        },
      },
    }
    const request = vi
      .fn()
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce(secondPage)
      .mockResolvedValueOnce(thirdPage)
    const sdk = graphql(vi.fn() as unknown as Requester)

    await expect(
      sdk.paginate(request as unknown as typeof sdk.closingIssues, {
        ...variables,
        cursor: "first",
      }),
    ).resolves.toBe(firstPage)
    expect(
      firstPage.repository.pullRequest.closingIssuesReferences.nodes,
    ).toStrictEqual([{ number: 1 }, { number: 3 }])
    expect(request).toHaveBeenCalledTimes(3)
    expect(request).toHaveBeenNthCalledWith(1, {
      ...variables,
      cursor: "first",
    })
    expect(request).toHaveBeenNthCalledWith(2, {
      ...variables,
      cursor: "second",
    })
    expect(request).toHaveBeenNthCalledWith(3, {
      ...variables,
      cursor: "third",
    })
  })

  test("returns a connection without page information", async () => {
    const response = { nodes: null, pageInfo: null }
    const request = vi.fn().mockResolvedValue(response)
    const sdk = graphql(vi.fn() as unknown as Requester)

    await expect(
      sdk.paginate(request as unknown as typeof sdk.closingIssues, variables),
    ).resolves.toBe(response)
  })

  test("rejects a truncated page", async () => {
    const request = vi.fn().mockResolvedValue({
      nodes: [],
      pageInfo: { endCursor: null, hasNextPage: true },
    })
    const sdk = graphql(vi.fn() as unknown as Requester)

    await expect(
      sdk.paginate(request as unknown as typeof sdk.closingIssues, variables),
    ).rejects.toThrow("GraphQL page was truncated")
  })
})
