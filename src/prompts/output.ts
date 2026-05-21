import type {
  CloseReconsiderationOutput,
  EditOutput,
  EditResponseAction,
  FindingValidationOutput,
  RereviewCloseReconsiderationOutput,
  RereviewOutput,
  ReviewOutput,
  TriageAction,
  TriageActionOutput,
  TriageBinaryVote,
  TriageCommentClassification,
  TriageCommentClassificationOutput,
  TriageDuplicateOutput,
  TriageDuplicateVote,
  TriageExistingPrVote,
  TriageCategoryVote,
  TriageVoteOutput,
  Verdict,
} from "../types"

export interface CiClassificationOutput {
  checks: {
    classification: "SCOPE_IN" | "SCOPE_OUT"
    name: string
    reason: string
  }[]
}

function extractJson(text: string): unknown {
  const trimmed = text.trim()

  try {
    return JSON.parse(trimmed)
  } catch {
    let depth = 0
    let escaped = false
    let inString = false
    let start = -1
    const candidates: string[] = []

    for (let index = 0; index < trimmed.length; index += 1) {
      const char = trimmed[index]

      if (escaped) {
        escaped = false
        continue
      }
      if (char === "\\" && inString) {
        escaped = true
        continue
      }
      if (char === '"') {
        inString = !inString
        continue
      }
      if (inString) continue

      if (char === "{") {
        if (depth === 0) start = index
        depth += 1
        continue
      }
      if (char !== "}" || depth === 0) continue

      depth -= 1
      if (depth === 0 && start !== -1) {
        candidates.push(trimmed.slice(start, index + 1))
        start = -1
      }
    }

    for (const candidate of candidates.reverse()) {
      try {
        return JSON.parse(candidate)
      } catch {
        // Keep scanning older JSON-looking blocks; prompts may include examples.
      }
    }

    throw new Error("output does not contain a valid JSON object")
  }
}

function isVerdict(value: unknown): value is Verdict {
  return value === "MERGE" || value === "CHANGES_REQUESTED" || value === "CLOSE"
}

function isEditResponseAction(value: unknown): value is EditResponseAction {
  return value === "FIXED" || value === "DISAGREE" || value === "ASK"
}

function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`)
  return value
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string" || !value)
    throw new Error(`${path} must be a non-empty string`)
  return value
}

function requireNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value))
    throw new Error(`${path} must be an integer`)
  return value
}

function requireLine(value: unknown, path: string): number {
  if (value == null) throw new Error(`${path} is required`)

  return requireNumber(value, path)
}

function optionalStartLine(input: {
  line: number
  path: string
  value: unknown
}): number | undefined {
  if (input.value == null) return undefined

  return requireNumber(input.value, input.path)
}

function requireOneOf<T extends string>(
  value: unknown,
  path: string,
  values: readonly T[],
): T {
  const text = requireString(value, path)
  if (!values.includes(text as T)) {
    throw new Error(`${path} must be ${values.join(", ")}`)
  }

  return text as T
}

function parseTriageVote<T extends string>(
  text: string,
  votes: readonly T[],
): TriageVoteOutput<T> {
  const data = extractJson(text) as Record<string, unknown>
  if (!data || typeof data !== "object")
    throw new Error("triage vote output must be an object")

  return {
    reason: requireString(data.reason, "reason"),
    vote: requireOneOf(data.vote, "vote", votes),
  }
}

export function parseTriageExistingPrOutput(
  text: string,
): TriageVoteOutput<TriageExistingPrVote> {
  return parseTriageVote(text, [
    "RELATED_PR_DOES_NOT_HANDLE_ISSUE",
    "RELATED_PR_HANDLES_ISSUE",
  ])
}

export function parseTriageCategoryOutput(
  text: string,
  categories: readonly string[],
): TriageVoteOutput<TriageCategoryVote> {
  return parseTriageVote(text, ["ASK", ...categories])
}

export function parseTriageBinaryOutput(
  text: string,
): TriageVoteOutput<TriageBinaryVote> {
  return parseTriageVote(text, ["ASK", "NO", "YES"])
}

export function parseTriageDuplicateOutput(
  text: string,
): TriageDuplicateOutput {
  const data = extractJson(text) as Record<string, unknown>
  if (!data || typeof data !== "object")
    throw new Error("triage duplicate output must be an object")

  const vote = requireOneOf<TriageDuplicateVote>(data.vote, "vote", [
    "DUPLICATE",
    "NOT_DUPLICATE",
  ])
  const duplicateOf =
    data.duplicateOf == null
      ? undefined
      : requireNumber(data.duplicateOf, "duplicateOf")

  if (vote === "DUPLICATE" && duplicateOf == null)
    throw new Error("DUPLICATE requires duplicateOf")

  return {
    duplicateOf,
    reason: requireString(data.reason, "reason"),
    vote,
  }
}

export function parseTriageCommentClassificationOutput(
  text: string,
): TriageCommentClassificationOutput {
  const data = extractJson(text) as Record<string, unknown>
  if (!data || typeof data !== "object")
    throw new Error("triage comment classification output must be an object")

  return {
    comments: requireArray(data.comments, "comments").map((item, index) => {
      const value = item as Record<string, unknown>

      return {
        classification: requireOneOf<TriageCommentClassification>(
          value.classification,
          `comments[${index}].classification`,
          [
            "ACKNOWLEDGEMENT",
            "CLARIFICATION",
            "NEW_EVIDENCE",
            "OBJECTION",
            "UNRELATED",
          ],
        ),
        commentId: requireNumber(
          value.commentId,
          `comments[${index}].commentId`,
        ),
        reason: requireString(value.reason, `comments[${index}].reason`),
      }
    }),
  }
}

export function parseTriageActionOutput(text: string): TriageActionOutput {
  const data = extractJson(text) as Record<string, unknown>
  if (!data || typeof data !== "object")
    throw new Error("triage action output must be an object")

  return {
    action: requireOneOf<TriageAction>(data.action, "action", [
      "ASK",
      "CLEAR_ONLY",
      "CLOSE",
      "COMMENT",
      "PR",
    ]),
    reason: requireString(data.reason, "reason"),
  }
}

export function parseReviewOutput(text: string): ReviewOutput {
  const data = extractJson(text) as Record<string, unknown>

  if (!data || typeof data !== "object")
    throw new Error("review output must be an object")
  if (data.requirementFindings != null)
    throw new Error("requirementFindings is not accepted")
  if (!isVerdict(data.verdict))
    throw new Error("verdict must be MERGE, CHANGES_REQUESTED, or CLOSE")

  const findings = requireArray(data.findings, "findings").map(
    (finding, index) => {
      const item = finding as Record<string, unknown>
      const line = requireLine(item.line, `findings[${index}].line`)

      return {
        fix: requireString(item.fix, `findings[${index}].fix`),
        issue: requireString(item.issue, `findings[${index}].issue`),
        line,
        path: requireString(item.path, `findings[${index}].path`),
        perspective:
          item.perspective == null
            ? undefined
            : requireString(item.perspective, `findings[${index}].perspective`),
        startLine: optionalStartLine({
          line,
          path: `findings[${index}].startLine`,
          value: item.startLine,
        }),
      }
    },
  )

  if (data.verdict === "MERGE" && findings.length)
    throw new Error("MERGE requires no findings")
  if (data.verdict === "CHANGES_REQUESTED" && !findings.length)
    throw new Error("CHANGES_REQUESTED requires findings")
  if (data.verdict === "CLOSE" && findings.length)
    throw new Error("CLOSE requires no findings")
  const reason =
    typeof data.reason === "string" && data.reason.trim()
      ? data.reason
      : undefined

  if (data.verdict === "CLOSE" && !reason)
    throw new Error("CLOSE requires reason")

  return {
    findings,
    reason,
    verdict: data.verdict,
  }
}

export function parseRereviewOutput(text: string): RereviewOutput {
  const data = extractJson(text) as Record<string, unknown>

  if (!isVerdict(data.verdict))
    throw new Error(
      "rereview verdict must be MERGE, CHANGES_REQUESTED, or CLOSE",
    )
  if (data.requirementFindings != null)
    throw new Error("requirementFindings is not accepted")

  const resolve = requireArray(data.resolve, "resolve").map((item, index) => {
    const value = item as Record<string, unknown>

    return {
      commentId: requireNumber(value.commentId, `resolve[${index}].commentId`),
      threadId: requireString(value.threadId, `resolve[${index}].threadId`),
    }
  })

  const followUps = requireArray(data.followUps, "followUps").map(
    (item, index) => {
      const value = item as Record<string, unknown>

      return {
        body: requireString(value.body, `followUps[${index}].body`),
        commentId: requireNumber(
          value.commentId,
          `followUps[${index}].commentId`,
        ),
      }
    },
  )

  const newFindings = requireArray(data.newFindings, "newFindings").map(
    (item, index) => {
      const value = item as Record<string, unknown>
      const line = requireLine(value.line, `newFindings[${index}].line`)

      return {
        body: requireString(value.body, `newFindings[${index}].body`),
        line,
        path: requireString(value.path, `newFindings[${index}].path`),
        startLine: optionalStartLine({
          line,
          path: `newFindings[${index}].startLine`,
          value: value.startLine,
        }),
      }
    },
  )

  if (data.verdict === "MERGE" && (followUps.length || newFindings.length)) {
    throw new Error("MERGE requires no followUps or newFindings")
  }

  if (data.verdict === "CLOSE" && (followUps.length || newFindings.length)) {
    throw new Error("CLOSE requires no followUps or newFindings")
  }

  if (data.verdict === "CLOSE" && !data.reason) {
    throw new Error("CLOSE requires reason")
  }

  if (
    data.verdict === "CHANGES_REQUESTED" &&
    !followUps.length &&
    !newFindings.length
  ) {
    throw new Error("CHANGES_REQUESTED requires followUps or newFindings")
  }

  return {
    followUps,
    newFindings,
    reason:
      data.reason == null ? undefined : requireString(data.reason, "reason"),
    resolve,
    verdict: data.verdict,
  }
}

export function parseFindingValidationOutput(
  text: string,
): FindingValidationOutput {
  const data = extractJson(text) as Record<string, unknown>

  if (!data || typeof data !== "object")
    throw new Error("finding validation output must be an object")

  return {
    votes: requireArray(data.votes, "votes").map((item, index) => {
      const value = item as Record<string, unknown>
      const vote = requireString(value.vote, `votes[${index}].vote`)

      if (vote !== "AGREE" && vote !== "DISAGREE")
        throw new Error(`votes[${index}].vote must be AGREE or DISAGREE`)

      return {
        findingIndex: requireNumber(
          value.findingIndex,
          `votes[${index}].findingIndex`,
        ),
        reason:
          value.reason == null
            ? undefined
            : requireString(value.reason, `votes[${index}].reason`),
        reviewer: requireString(value.reviewer, `votes[${index}].reviewer`),
        vote,
      }
    }),
  }
}

export function parseCloseReconsiderationOutput(
  text: string,
): CloseReconsiderationOutput {
  const output = parseReviewOutput(text)

  if (output.verdict === "CLOSE")
    throw new Error("close reconsideration must be MERGE or CHANGES_REQUESTED")

  return output as CloseReconsiderationOutput
}

export function parseRereviewCloseReconsiderationOutput(
  text: string,
): RereviewCloseReconsiderationOutput {
  const output = parseRereviewOutput(text)

  if (output.verdict === "CLOSE")
    throw new Error(
      "rereview close reconsideration must be MERGE or CHANGES_REQUESTED",
    )

  return output as RereviewCloseReconsiderationOutput
}

export function parseCiClassificationOutput(
  text: string,
): CiClassificationOutput {
  const data = extractJson(text) as Record<string, unknown>

  if (!data || typeof data !== "object")
    throw new Error("CI classification output must be an object")

  return {
    checks: requireArray(data.checks, "checks").map((item, index) => {
      const value = item as Record<string, unknown>
      const classification = requireString(
        value.classification,
        `checks[${index}].classification`,
      )

      if (classification !== "SCOPE_IN" && classification !== "SCOPE_OUT") {
        throw new Error(
          `checks[${index}].classification must be SCOPE_IN or SCOPE_OUT`,
        )
      }

      return {
        classification,
        name: requireString(value.name, `checks[${index}].name`),
        reason: requireString(value.reason, `checks[${index}].reason`),
      }
    }),
  }
}

function parsePullRequest(
  value: unknown,
  options: { required: boolean },
): EditOutput["pullRequest"] {
  if (value == null) {
    if (options.required) throw new Error("pullRequest is required")
    return undefined
  }
  if (typeof value !== "object")
    throw new Error("pullRequest must be an object")

  const pullRequest = value as Record<string, unknown>

  return {
    body: requireString(pullRequest.body, "pullRequest.body"),
    title: requireString(pullRequest.title, "pullRequest.title"),
  }
}

function parseEditOutputWithOptions(
  text: string,
  options: { requirePullRequest: boolean; requireResponses: boolean },
): EditOutput {
  const data = extractJson(text) as Record<string, unknown>

  if (!data || typeof data !== "object")
    throw new Error("edit output must be an object")
  if (data.mode !== "EDITED" && data.mode !== "REPLIED")
    throw new Error("mode must be EDITED or REPLIED")

  const filesTouched = requireArray(data.filesTouched, "filesTouched").map(
    (file, index) => requireString(file, `filesTouched[${index}]`),
  )
  const responses = requireArray(data.responses, "responses").map(
    (item, index) => {
      const value = item as Record<string, unknown>

      if (!isEditResponseAction(value.action)) {
        throw new Error(
          `responses[${index}].action must be FIXED, DISAGREE, or ASK`,
        )
      }

      return {
        action: value.action,
        body: requireString(value.body, `responses[${index}].body`),
        commentId: requireNumber(
          value.commentId,
          `responses[${index}].commentId`,
        ),
      }
    },
  )

  if (options.requireResponses && data.mode === "REPLIED" && !responses.length)
    throw new Error("responses must not be empty")

  if (data.mode === "EDITED") {
    if (!filesTouched.length) throw new Error("EDITED requires filesTouched")
    const pullRequest = parsePullRequest(data.pullRequest, {
      required: options.requirePullRequest,
    })

    return {
      commitMessage: requireString(data.commitMessage, "commitMessage"),
      commitSha: requireString(data.commitSha, "commitSha"),
      filesTouched,
      mode: data.mode,
      ...(pullRequest ? { pullRequest } : {}),
      responses,
    }
  }

  if (data.commitMessage != null)
    throw new Error("REPLIED must omit commitMessage")
  if (data.commitSha != null) throw new Error("REPLIED must omit commitSha")
  if (filesTouched.length)
    throw new Error("REPLIED requires empty filesTouched")
  if (responses.some((response) => response.action === "FIXED")) {
    throw new Error("REPLIED cannot include FIXED responses")
  }

  return {
    filesTouched,
    mode: data.mode,
    responses,
  }
}

export function parseEditOutput(text: string): EditOutput {
  return parseEditOutputWithOptions(text, {
    requirePullRequest: false,
    requireResponses: true,
  })
}

export function parseTriageCreatePrOutput(text: string): EditOutput {
  return parseEditOutputWithOptions(text, {
    requirePullRequest: true,
    requireResponses: false,
  })
}
