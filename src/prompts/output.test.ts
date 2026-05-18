import { describe, expect, test } from "vitest"
import {
  parseEditOutput,
  parseFindingValidationOutput,
  parseRereviewOutput,
  parseReviewOutput,
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
})
