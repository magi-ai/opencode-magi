import type { CheckWaitReport } from "../github/commands"
import type { ResolvedRepository } from "../types"
import { describe, expect, test } from "vitest"
import { formatMergeReport, formatReviewReport } from "./report"

const repository = {
  agents: {
    reviewers: [
      { account: "bot-a", index: 0, key: "alpha", model: "test/model" },
      { account: "bot-b", index: 1, key: "beta", model: "test/model" },
      { account: "bot-c", index: 2, key: "gamma", model: "test/model" },
    ],
  },
} as ResolvedRepository

const passingChecks: CheckWaitReport[] = [
  {
    attempts: 0,
    excluded: [],
    failed: [],
    rerun: [],
    scopeInside: [],
    scopeOutsideRecovered: [],
    scopeOutsideUnresolved: [],
  },
]

describe("report formatting", () => {
  test("formats review report with posted change request and discarded finding", () => {
    const report = formatReviewReport({
      ciReports: passingChecks,
      discardedFindings: [
        {
          finding: {
            fix: "Remove it.",
            issue: "Minor nit.",
            line: 11,
            path: "src/a.ts",
          },
          findingIndex: 1,
          reviewer: "alpha",
        },
      ],
      outputs: {
        alpha: {
          findings: [
            {
              fix: "Use a guard.",
              issue: "Unsafe cast.",
              line: 10,
              path: "src/a.ts",
            },
          ],
          verdict: "CHANGES_REQUESTED",
        },
        beta: { findings: [], verdict: "MERGE" },
        gamma: { findings: [], verdict: "MERGE" },
      },
      posted: {
        alpha: "https://github.com/o/r/pull/1#pullrequestreview-1",
      },
      repository,
    })

    expect(report).toContain("- **Check**: Pass")
    expect(report).toContain(
      "- **alpha**: [Changes requested](https://github.com/o/r/pull/1#pullrequestreview-1)",
    )
    expect(report).toContain("`src/a.ts:10`: Unsafe cast.")
    expect(report).toContain("~~`src/a.ts:11`: Minor nit.~~")
    expect(report).toContain("- **beta**: Approved")
  })

  test("formats merge report with failed CI and editor summary", () => {
    const report = formatMergeReport({
      ciReports: [
        {
          attempts: 3,
          excluded: [],
          failed: [],
          rerun: [],
          scopeInside: [
            {
              check: {
                bucket: "fail",
                link: "https://github.com/o/r/actions/runs/1/job/2",
                name: "TypeScript",
                state: "FAILURE",
                workflow: "CI",
              },
              classification: "SCOPE_IN",
              reason: "Type error in changed file.",
            },
          ],
          scopeOutsideRecovered: [],
          scopeOutsideUnresolved: [],
        },
      ],
      editorOutputs: [
        {
          commitMessage: "fix: remove unsafe cast",
          commitSha: "abcdef1234567890",
          filesTouched: ["src/a.ts"],
          mode: "EDITED",
          responses: [{ action: "FIXED", body: "Fixed.", commentId: 123 }],
        },
      ],
      outputs: {
        alpha: { findings: [], verdict: "MERGE" },
        beta: { findings: [], verdict: "MERGE" },
        gamma: { findings: [], verdict: "MERGE" },
      },
      posted: {},
      repository,
      status: "ci_unresolved",
    })

    expect(report).toContain("- **Status**: Failed")
    expect(report).toContain("- **Check**: Failure")
    expect(report).toContain("- **TypeScript**: Type error in changed file.")
    expect(report).toContain("- **Editor**:")
    expect(report).toContain("Cycle 1: fix: remove unsafe cast (abcdef1)")
    expect(report).toContain("src/a.ts")
    expect(report).toContain("FIXED comment #123: Fixed.")
  })

  test("reports editor replies without code changes", () => {
    const report = formatMergeReport({
      ciReports: [],
      editorOutputs: [
        {
          filesTouched: [],
          mode: "REPLIED",
          responses: [
            {
              action: "ASK",
              body: "Can you clarify the expected behavior?",
              commentId: 123,
            },
          ],
        },
      ],
      outputs: {
        alpha: { findings: [], verdict: "MERGE" },
        beta: { findings: [], verdict: "MERGE" },
        gamma: { findings: [], verdict: "MERGE" },
      },
      posted: {},
      repository,
      status: "changes_unresolved",
    })

    expect(report).toContain("Cycle 1: replied without code changes")
    expect(report).toContain(
      "ASK comment #123: Can you clarify the expected behavior?",
    )
  })
})
