import { describe, expect, test } from "vitest"
import {
  parseEditOutput,
  parseFindingValidationOutput,
  parseRereviewOutput,
  parseReviewOutput,
  parseTriageBinaryOutput,
  parseTriageActionOutput,
  parseTriageCommentClassificationOutput,
  parseTriageCreatePrOutput,
  parseTriageDuplicateOutput,
  parseTriageCategoryOutput,
} from "./output"

describe("review output", () => {
  test("parses valid merge output", () => {
    expect(parseReviewOutput('{"verdict":"MERGE","findings":[]}')).toEqual({
      findings: [],
      reason: undefined,
      verdict: "MERGE",
    })
  })

  test("rejects changes requested without findings", () => {
    expect(() =>
      parseReviewOutput('{"verdict":"CHANGES_REQUESTED","findings":[]}'),
    ).toThrow("CHANGES_REQUESTED requires findings")
  })

  test("rejects requirement findings", () => {
    expect(() =>
      parseReviewOutput(
        JSON.stringify({
          findings: [],
          requirementFindings: [
            {
              evidence: "Runtime path is missing.",
              fix: "Wire the handler.",
              issueNumber: 47,
              requirement: "Support reconsideration.",
            },
          ],
          verdict: "CHANGES_REQUESTED",
        }),
      ),
    ).toThrow("requirementFindings is not accepted")
  })

  test("rejects findings without a line", () => {
    expect(() =>
      parseReviewOutput(
        JSON.stringify({
          findings: [
            {
              fix: "Pass structured findings to the editor.",
              issue: "The editor cannot see body-only findings.",
              path: "src/orchestrator/merge.ts",
            },
          ],
          verdict: "CHANGES_REQUESTED",
        }),
      ),
    ).toThrow("findings[0].line is required")
  })

  test("parses missing closing-issue requirements as normal findings", () => {
    expect(
      parseReviewOutput(
        JSON.stringify({
          findings: [
            {
              fix: "Ensure every requested change is posted inline.",
              issue:
                "The PR claims to close issue #123 but does not preserve rereview triggering for requested changes.",
              line: 366,
              path: "src/orchestrator/review.ts",
            },
          ],
          verdict: "CHANGES_REQUESTED",
        }),
      ),
    ).toMatchObject({
      findings: [
        {
          line: 366,
          path: "src/orchestrator/review.ts",
        },
      ],
      verdict: "CHANGES_REQUESTED",
    })
  })

  test("rejects startLine without line", () => {
    expect(() =>
      parseReviewOutput(
        JSON.stringify({
          findings: [
            {
              fix: "Use line or omit startLine.",
              issue: "startLine cannot be posted without a line.",
              path: "src/app.ts",
              startLine: 10,
            },
          ],
          verdict: "CHANGES_REQUESTED",
        }),
      ),
    ).toThrow("findings[0].line is required")
  })

  test("rejects merge with requirement findings", () => {
    expect(() =>
      parseReviewOutput(
        JSON.stringify({
          findings: [],
          requirementFindings: [
            {
              evidence: "Missing behavior.",
              fix: "Implement it.",
              issueNumber: 47,
              requirement: "Required behavior.",
            },
          ],
          verdict: "MERGE",
        }),
      ),
    ).toThrow("requirementFindings is not accepted")
  })

  test("extracts json from noisy output", () => {
    const result = parseReviewOutput(
      'noise {"verdict":"CLOSE","findings":[],"reason":"wrong premise"} trailing',
    )

    expect(result.verdict).toBe("CLOSE")
    expect(result.reason).toBe("wrong premise")
  })

  test("uses the latest valid json object when prompts are included", () => {
    const result = parseReviewOutput(
      [
        "Your previous review output did not match the required schema.",
        "The object must match this shape:",
        "{",
        '  "verdict": "MERGE" | "CHANGES_REQUESTED" | "CLOSE",',
        '  "findings": []',
        "}",
        '{"verdict":"MERGE","findings":[],"reason":""}',
      ].join("\n"),
    )

    expect(result).toEqual({
      findings: [],
      reason: undefined,
      verdict: "MERGE",
    })
  })

  test("parses close rereview output", () => {
    expect(
      parseRereviewOutput(
        '{"verdict":"CLOSE","resolve":[],"followUps":[],"newFindings":[],"reason":"invalid premise"}',
      ),
    ).toEqual({
      followUps: [],
      newFindings: [],
      reason: "invalid premise",
      resolve: [],
      verdict: "CLOSE",
    })
  })

  test("rejects rereview findings without a line", () => {
    expect(() =>
      parseRereviewOutput(
        JSON.stringify({
          followUps: [],
          newFindings: [
            {
              body: "The behavior is still incomplete.",
              path: "src/orchestrator/merge.ts",
            },
          ],
          resolve: [],
          verdict: "CHANGES_REQUESTED",
        }),
      ),
    ).toThrow("newFindings[0].line is required")
  })

  test("rejects rereview requirement findings", () => {
    expect(() =>
      parseRereviewOutput(
        JSON.stringify({
          followUps: [],
          newFindings: [],
          requirementFindings: [
            {
              evidence: "Missing runtime behavior.",
              fix: "Wire it.",
              issueNumber: 47,
              requirement: "Runtime behavior.",
            },
          ],
          resolve: [],
          verdict: "CHANGES_REQUESTED",
        }),
      ),
    ).toThrow("requirementFindings is not accepted")
  })

  test("parses finding validation votes", () => {
    expect(
      parseFindingValidationOutput(
        '{"votes":[{"reviewer":"a","findingIndex":0,"vote":"AGREE"}]}',
      ),
    ).toEqual({
      votes: [{ findingIndex: 0, reviewer: "a", vote: "AGREE" }],
    })
  })

  test("parses edited editor output", () => {
    expect(
      parseEditOutput(
        JSON.stringify({
          commitMessage: "fix: handle null input",
          commitSha: "abcdef1234567890",
          filesTouched: ["src/app.ts"],
          mode: "EDITED",
          responses: [{ action: "FIXED", body: "Fixed.", commentId: 1 }],
        }),
      ),
    ).toEqual({
      commitMessage: "fix: handle null input",
      commitSha: "abcdef1234567890",
      filesTouched: ["src/app.ts"],
      mode: "EDITED",
      responses: [{ action: "FIXED", body: "Fixed.", commentId: 1 }],
    })
  })

  test("allows edited editor output without thread responses", () => {
    expect(
      parseEditOutput(
        JSON.stringify({
          commitMessage: "fix: handle body-only findings",
          commitSha: "abcdef1234567890",
          filesTouched: ["src/app.ts"],
          mode: "EDITED",
          responses: [],
        }),
      ),
    ).toEqual({
      commitMessage: "fix: handle body-only findings",
      commitSha: "abcdef1234567890",
      filesTouched: ["src/app.ts"],
      mode: "EDITED",
      responses: [],
    })
  })

  test("parses reply-only editor output", () => {
    expect(
      parseEditOutput(
        JSON.stringify({
          filesTouched: [],
          mode: "REPLIED",
          responses: [
            {
              action: "ASK",
              body: "Can you clarify the expected behavior?",
              commentId: 1,
            },
          ],
        }),
      ),
    ).toEqual({
      filesTouched: [],
      mode: "REPLIED",
      responses: [
        {
          action: "ASK",
          body: "Can you clarify the expected behavior?",
          commentId: 1,
        },
      ],
    })
  })

  test("rejects reply-only editor output with fixed responses", () => {
    expect(() =>
      parseEditOutput(
        JSON.stringify({
          filesTouched: [],
          mode: "REPLIED",
          responses: [{ action: "FIXED", body: "Fixed.", commentId: 1 }],
        }),
      ),
    ).toThrow("REPLIED cannot include FIXED responses")
  })

  test("allows triage PR creation output without comment responses", () => {
    expect(
      parseTriageCreatePrOutput(
        JSON.stringify({
          commitMessage: "fix: address issue",
          commitSha: "abcdef1234567890",
          filesTouched: ["src/app.ts"],
          mode: "EDITED",
          pullRequest: {
            body: "Closes #1",
            title: "fix: address issue #1",
          },
          responses: [],
        }),
      ),
    ).toEqual({
      commitMessage: "fix: address issue",
      commitSha: "abcdef1234567890",
      filesTouched: ["src/app.ts"],
      mode: "EDITED",
      pullRequest: {
        body: "Closes #1",
        title: "fix: address issue #1",
      },
      responses: [],
    })
  })

  test("requires triage PR metadata for edited PR creation output", () => {
    expect(() =>
      parseTriageCreatePrOutput(
        JSON.stringify({
          commitMessage: "fix: address issue",
          commitSha: "abcdef1234567890",
          filesTouched: ["src/app.ts"],
          mode: "EDITED",
          responses: [],
        }),
      ),
    ).toThrow("pullRequest is required")
  })
})

describe("triage output parsing", () => {
  test("parses category and binary votes", () => {
    expect(
      parseTriageCategoryOutput('{"vote":"bug","reason":"broken"}', [
        "bug",
        "feature",
      ]),
    ).toEqual({
      reason: "broken",
      vote: "bug",
    })
    expect(
      parseTriageBinaryOutput('{"vote":"ASK","reason":"missing"}'),
    ).toEqual({
      reason: "missing",
      vote: "ASK",
    })
  })

  test("requires duplicate target for duplicate vote", () => {
    expect(
      parseTriageDuplicateOutput(
        '{"vote":"DUPLICATE","duplicateOf":42,"reason":"same"}',
      ),
    ).toEqual({ duplicateOf: 42, reason: "same", vote: "DUPLICATE" })
    expect(() =>
      parseTriageDuplicateOutput('{"vote":"DUPLICATE","reason":"same"}'),
    ).toThrow("DUPLICATE requires duplicateOf")
  })

  test("parses triage action and comment classification output", () => {
    expect(
      parseTriageActionOutput('{"action":"PR","reason":"accepted"}'),
    ).toEqual({
      action: "PR",
      reason: "accepted",
    })
    expect(
      parseTriageCommentClassificationOutput(
        '{"comments":[{"commentId":123,"classification":"NEW_EVIDENCE","reason":"log"}]}',
      ),
    ).toEqual({
      comments: [
        { classification: "NEW_EVIDENCE", commentId: 123, reason: "log" },
      ],
    })
  })
})
