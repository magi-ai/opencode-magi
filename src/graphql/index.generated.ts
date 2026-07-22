/** Internal type. DO NOT USE DIRECTLY. */
type Exact<T extends { [key: string]: unknown }> = { [K in keyof T]: T[K] };
/** Internal type. DO NOT USE DIRECTLY. */
export type Incremental<T> = T | { [P in keyof T]?: P extends ' $fragmentName' | '__typename' ? T[P] : never };
import { DocumentNode } from 'graphql';
import gql from 'graphql-tag';
/** The possible states of an issue. */
export type IssueState =
  /** An issue that has been closed */
  | 'CLOSED'
  /** An issue that is still open */
  | 'OPEN';

/** The possible states of a pull request. */
export type PullRequestState =
  /** A pull request that has been closed without being merged. */
  | 'CLOSED'
  /** A pull request that has been closed by being merged. */
  | 'MERGED'
  /** A pull request that is still open. */
  | 'OPEN';

export type ClosingIssuesQueryVariables = Exact<{
  cursor: string | null | undefined;
  owner: string;
  repo: string;
  pr: number;
}>;


export type ClosingIssuesQuery = { repository: { pullRequest: { closingIssuesReferences: { nodes: Array<{ body: string, number: number, state: IssueState, title: string, url: string, author:
            | { login: string }
            | { login: string }
            | { login: string }
            | { login: string }
            | { login: string }
           | null, comments: { nodes: Array<{ body: string, createdAt: string, databaseId: number | null, url: string, author:
                | { login: string }
                | { login: string }
                | { login: string }
                | { login: string }
                | { login: string }
               | null } | null> | null } } | null> | null, pageInfo: { endCursor: string | null, hasNextPage: boolean } } | null } | null } | null };

export type EnqueuePullRequestMutationVariables = Exact<{
  id: string | number;
}>;


export type EnqueuePullRequestMutation = { enqueuePullRequest: { mergeQueueEntry: { id: string } | null } | null };

export type MergeQueueStatusQueryVariables = Exact<{
  owner: string;
  repo: string;
  pr: number;
}>;


export type MergeQueueStatusQuery = { repository: { pullRequest: { state: PullRequestState, isInMergeQueue: boolean, mergeQueueEntry: { id: string } | null, timelineItems: { nodes: Array<
          | { createdAt: string, reason: string | null }
          | Record<PropertyKey, never>
         | null> | null } } | null } | null };

export type ResolveReviewThreadMutationVariables = Exact<{
  threadId: string | number;
}>;


export type ResolveReviewThreadMutation = { resolveReviewThread: { thread: { id: string } | null } | null };

export type ReviewThreadsQueryVariables = Exact<{
  cursor: string | null | undefined;
  owner: string;
  repo: string;
  pr: number;
}>;


export type ReviewThreadsQuery = { repository: { pullRequest: { reviewThreads: { nodes: Array<{ id: string, isResolved: boolean, line: number | null, path: string, comments: { nodes: Array<{ body: string, createdAt: string, databaseId: number | null, url: string, author:
                | { login: string }
                | { login: string }
                | { login: string }
                | { login: string }
                | { login: string }
               | null } | null> | null } } | null> | null, pageInfo: { endCursor: string | null, hasNextPage: boolean } } } | null } | null };


export const ClosingIssuesDocument = gql`
    query closingIssues($cursor: String, $owner: String!, $repo: String!, $pr: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      closingIssuesReferences(first: 50, after: $cursor) {
        nodes {
          author {
            login
          }
          body
          comments(last: 50) {
            nodes {
              author {
                login
              }
              body
              createdAt
              databaseId
              url
            }
          }
          number
          state
          title
          url
        }
        pageInfo {
          endCursor
          hasNextPage
        }
      }
    }
  }
}
    `;
export const EnqueuePullRequestDocument = gql`
    mutation enqueuePullRequest($id: ID!) {
  enqueuePullRequest(input: {pullRequestId: $id}) {
    mergeQueueEntry {
      id
    }
  }
}
    `;
export const MergeQueueStatusDocument = gql`
    query mergeQueueStatus($owner: String!, $repo: String!, $pr: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      state
      isInMergeQueue
      mergeQueueEntry {
        id
      }
      timelineItems(last: 1, itemTypes: REMOVED_FROM_MERGE_QUEUE_EVENT) {
        nodes {
          ... on RemovedFromMergeQueueEvent {
            createdAt
            reason
          }
        }
      }
    }
  }
}
    `;
export const ResolveReviewThreadDocument = gql`
    mutation resolveReviewThread($threadId: ID!) {
  resolveReviewThread(input: {threadId: $threadId}) {
    thread {
      id
    }
  }
}
    `;
export const ReviewThreadsDocument = gql`
    query reviewThreads($cursor: String, $owner: String!, $repo: String!, $pr: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      reviewThreads(first: 50, after: $cursor) {
        nodes {
          comments(last: 50) {
            nodes {
              author {
                login
              }
              body
              createdAt
              databaseId
              url
            }
          }
          id
          isResolved
          line
          path
        }
        pageInfo {
          endCursor
          hasNextPage
        }
      }
    }
  }
}
    `;
export type Requester<C = {}> = <R, V>(doc: DocumentNode, vars?: V, options?: C) => Promise<R> | AsyncIterable<R>
export function getSdk<C>(requester: Requester<C>) {
  return {
    closingIssues(variables: ClosingIssuesQueryVariables, options?: C): Promise<ClosingIssuesQuery> {
      return requester<ClosingIssuesQuery, ClosingIssuesQueryVariables>(ClosingIssuesDocument, variables, options) as Promise<ClosingIssuesQuery>;
    },
    enqueuePullRequest(variables: EnqueuePullRequestMutationVariables, options?: C): Promise<EnqueuePullRequestMutation> {
      return requester<EnqueuePullRequestMutation, EnqueuePullRequestMutationVariables>(EnqueuePullRequestDocument, variables, options) as Promise<EnqueuePullRequestMutation>;
    },
    mergeQueueStatus(variables: MergeQueueStatusQueryVariables, options?: C): Promise<MergeQueueStatusQuery> {
      return requester<MergeQueueStatusQuery, MergeQueueStatusQueryVariables>(MergeQueueStatusDocument, variables, options) as Promise<MergeQueueStatusQuery>;
    },
    resolveReviewThread(variables: ResolveReviewThreadMutationVariables, options?: C): Promise<ResolveReviewThreadMutation> {
      return requester<ResolveReviewThreadMutation, ResolveReviewThreadMutationVariables>(ResolveReviewThreadDocument, variables, options) as Promise<ResolveReviewThreadMutation>;
    },
    reviewThreads(variables: ReviewThreadsQueryVariables, options?: C): Promise<ReviewThreadsQuery> {
      return requester<ReviewThreadsQuery, ReviewThreadsQueryVariables>(ReviewThreadsDocument, variables, options) as Promise<ReviewThreadsQuery>;
    }
  };
}
export type Sdk = ReturnType<typeof getSdk>;