import { describe, expect, test } from "vitest"
import { applyFindingValidation, reviewFindingTargets } from "./findings"

describe("applyFindingValidation", () => {
  test("keeps only findings that reach finding-level majority", () => {
    const result = applyFindingValidation({
      outputs: {
        a: {
          verdict: "CHANGES_REQUESTED",
          findings: [
            { fix: "fix 1", issue: "issue 1", line: 1, path: "a.ts" },
            { fix: "fix 2", issue: "issue 2", line: 2, path: "a.ts" },
          ],
        },
        b: { findings: [], verdict: "MERGE" },
        c: { findings: [], verdict: "MERGE" },
      },
      reviewerKeys: ["a", "b", "c"],
      validations: {
        b: {
          votes: [
            { findingIndex: 0, reviewer: "a", vote: "AGREE" },
            { findingIndex: 1, reviewer: "a", vote: "DISAGREE" },
          ],
        },
        c: {
          votes: [
            { findingIndex: 0, reviewer: "a", vote: "DISAGREE" },
            { findingIndex: 1, reviewer: "a", vote: "DISAGREE" },
          ],
        },
      },
    })

    expect(result.outputs.a.verdict).toBe("CHANGES_REQUESTED")
    expect(result.outputs.a.findings).toHaveLength(1)
    expect(result.outputs.a.findings[0].issue).toBe("issue 1")
  })

  test("turns changes requested into merge when all findings are rejected", () => {
    const result = applyFindingValidation({
      outputs: {
        a: {
          verdict: "CHANGES_REQUESTED",
          findings: [{ fix: "fix", issue: "issue", line: 1, path: "a.ts" }],
        },
        b: { findings: [], verdict: "MERGE" },
        c: { findings: [], verdict: "MERGE" },
      },
      reviewerKeys: ["a", "b", "c"],
      validations: {
        b: { votes: [{ findingIndex: 0, reviewer: "a", vote: "DISAGREE" }] },
        c: { votes: [{ findingIndex: 0, reviewer: "a", vote: "DISAGREE" }] },
      },
    })

    expect(result.outputs.a).toEqual({
      findings: [],
      verdict: "MERGE",
    })
  })

  test("keeps changes requested when a normal finding remains", () => {
    const result = applyFindingValidation({
      outputs: {
        a: {
          findings: [
            { fix: "fix 1", issue: "issue 1", line: 1, path: "a.ts" },
            { fix: "fix 2", issue: "issue 2", line: 2, path: "a.ts" },
          ],
          verdict: "CHANGES_REQUESTED",
        },
        b: { findings: [], verdict: "MERGE" },
        c: { findings: [], verdict: "MERGE" },
      },
      reviewerKeys: ["a", "b", "c"],
      validations: {
        b: {
          votes: [
            { findingIndex: 0, reviewer: "a", vote: "DISAGREE" },
            { findingIndex: 1, reviewer: "a", vote: "AGREE" },
          ],
        },
        c: {
          votes: [
            { findingIndex: 0, reviewer: "a", vote: "DISAGREE" },
            { findingIndex: 1, reviewer: "a", vote: "DISAGREE" },
          ],
        },
      },
    })

    expect(result.outputs.a.verdict).toBe("CHANGES_REQUESTED")
    expect(result.outputs.a.findings).toEqual([
      { fix: "fix 2", issue: "issue 2", line: 2, path: "a.ts" },
    ])
  })

  test("includes rereview new findings in validation targets", () => {
    expect(
      reviewFindingTargets({
        a: {
          followUps: [],
          newFindings: [{ body: "issue", line: 1, path: "a.ts" }],
          resolve: [],
          verdict: "CHANGES_REQUESTED",
        },
      }),
    ).toEqual([
      {
        finding: {
          fix: "Please address this before merging.",
          issue: "issue",
          line: 1,
          path: "a.ts",
          startLine: undefined,
        },
        findingIndex: 0,
        reviewer: "a",
      },
    ])
  })

  test("filters rereview new findings using finding-level majority", () => {
    const result = applyFindingValidation({
      outputs: {
        a: {
          followUps: [],
          newFindings: [
            { body: "issue 1", line: 1, path: "a.ts" },
            { body: "issue 2", line: 2, path: "a.ts" },
          ],
          resolve: [],
          verdict: "CHANGES_REQUESTED",
        },
        b: { followUps: [], newFindings: [], resolve: [], verdict: "MERGE" },
        c: { followUps: [], newFindings: [], resolve: [], verdict: "MERGE" },
      },
      reviewerKeys: ["a", "b", "c"],
      validations: {
        b: {
          votes: [
            { findingIndex: 0, reviewer: "a", vote: "DISAGREE" },
            { findingIndex: 1, reviewer: "a", vote: "AGREE" },
          ],
        },
        c: {
          votes: [
            { findingIndex: 0, reviewer: "a", vote: "DISAGREE" },
            { findingIndex: 1, reviewer: "a", vote: "DISAGREE" },
          ],
        },
      },
    })

    expect(result.outputs.a).toMatchObject({
      newFindings: [{ body: "issue 2", line: 2, path: "a.ts" }],
      verdict: "CHANGES_REQUESTED",
    })
  })

  test("turns rereview into merge when all new findings are rejected", () => {
    const result = applyFindingValidation({
      outputs: {
        a: {
          followUps: [],
          newFindings: [{ body: "issue", line: 1, path: "a.ts" }],
          resolve: [],
          verdict: "CHANGES_REQUESTED",
        },
        b: { followUps: [], newFindings: [], resolve: [], verdict: "MERGE" },
        c: { followUps: [], newFindings: [], resolve: [], verdict: "MERGE" },
      },
      reviewerKeys: ["a", "b", "c"],
      validations: {
        b: { votes: [{ findingIndex: 0, reviewer: "a", vote: "DISAGREE" }] },
        c: { votes: [{ findingIndex: 0, reviewer: "a", vote: "DISAGREE" }] },
      },
    })

    expect(result.outputs.a).toMatchObject({
      newFindings: [],
      verdict: "MERGE",
    })
  })

  test("keeps rereview changes requested when follow-ups remain", () => {
    const result = applyFindingValidation({
      outputs: {
        a: {
          followUps: [{ body: "Please still update this.", commentId: 1 }],
          newFindings: [{ body: "issue", line: 1, path: "a.ts" }],
          resolve: [],
          verdict: "CHANGES_REQUESTED",
        },
        b: { followUps: [], newFindings: [], resolve: [], verdict: "MERGE" },
        c: { followUps: [], newFindings: [], resolve: [], verdict: "MERGE" },
      },
      reviewerKeys: ["a", "b", "c"],
      validations: {
        b: { votes: [{ findingIndex: 0, reviewer: "a", vote: "DISAGREE" }] },
        c: { votes: [{ findingIndex: 0, reviewer: "a", vote: "DISAGREE" }] },
      },
    })

    expect(result.outputs.a).toMatchObject({
      newFindings: [],
      verdict: "CHANGES_REQUESTED",
    })
  })
})
