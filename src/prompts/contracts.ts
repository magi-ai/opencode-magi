export const reviewOutputContract = `
<output_contract>
Return exactly one JSON object and nothing else. Do not wrap it in markdown.

The object must match this shape:
{
  "verdict": "MERGE" | "CHANGES_REQUESTED" | "CLOSE",
  "findings": [
    {
      "path": "relative/path.ext",
      "line": 123,
      "startLine": 120,
      "issue": "What is wrong.",
      "fix": "How to fix it.",
      "perspective": "Optional review perspective."
    }
  ],
  "requirementFindings": [
    {
      "issueNumber": 47,
      "requirement": "Required closing-issue behavior that is missing.",
      "evidence": "Why the PR does not satisfy the requirement.",
      "fix": "How to satisfy the requirement."
    }
  ],
  "reason": "Required only for CLOSE."
}

Rules:
- MERGE requires empty findings and requirementFindings arrays.
- CHANGES_REQUESTED requires at least one finding or requirementFinding.
- CLOSE requires a reason and empty findings and requirementFindings arrays.
- path must be repository-relative.
- line and startLine must refer to lines inside the PR diff hunk.
- Omit startLine for single-line findings.
- Use requirementFindings for missing closing-issue requirements that do not map cleanly to a diff line.
</output_contract>`.trim()

export const rereviewOutputContract = `
<output_contract>
Return exactly one JSON object and nothing else. Do not wrap it in markdown.

The object must match this shape:
{
  "verdict": "MERGE" | "CHANGES_REQUESTED" | "CLOSE",
  "resolve": [{ "commentId": 123, "threadId": "..." }],
  "followUps": [{ "commentId": 123, "body": "..." }],
  "newFindings": [{ "path": "relative/path.ext", "line": 123, "startLine": 120, "body": "..." }],
  "requirementFindings": [{ "issueNumber": 47, "requirement": "Missing requirement.", "evidence": "Why it is missing.", "fix": "How to fix it." }],
  "reason": "Required only for CLOSE."
}

Rules:
- MERGE requires empty followUps, newFindings, and requirementFindings arrays.
- CHANGES_REQUESTED requires at least one followUp, newFinding, or requirementFinding.
- CLOSE requires a reason and empty followUps, newFindings, and requirementFindings arrays.
- line and startLine must refer to lines inside the latest PR diff hunk.
- Omit startLine for single-line findings.
- Use requirementFindings for missing closing-issue requirements that do not map cleanly to a diff line.
</output_contract>`.trim()

export const findingValidationOutputContract = `
<output_contract>
Return exactly one JSON object and nothing else. Do not wrap it in markdown.

The object must match this shape:
{
  "votes": [
    {
      "reviewer": "reviewer-key-that-authored-the-finding",
      "findingIndex": 0,
      "vote": "AGREE" | "DISAGREE",
      "reason": "Optional short rationale."
    }
  ]
}

Rules:
- Vote on every finding listed in the task.
- Do not vote on your own findings.
- AGREE means the finding should remain posted.
- DISAGREE means the finding should be discarded.
</output_contract>`.trim()

export const closeReconsiderationOutputContract = `
<output_contract>
Return exactly one JSON object and nothing else. Do not wrap it in markdown.

The object must match this shape:
{
  "verdict": "MERGE" | "CHANGES_REQUESTED",
  "findings": [
    {
      "path": "relative/path.ext",
      "line": 123,
      "startLine": 120,
      "issue": "What is wrong.",
      "fix": "How to fix it."
    }
  ],
  "requirementFindings": [{ "issueNumber": 47, "requirement": "Missing requirement.", "evidence": "Why it is missing.", "fix": "How to fix it." }]
}

Rules:
- MERGE requires empty findings and requirementFindings arrays.
- CHANGES_REQUESTED requires at least one finding or requirementFinding.
- CLOSE is not allowed in this reconsideration step.
- Omit startLine for single-line findings.
</output_contract>`.trim()

export const rereviewCloseReconsiderationOutputContract = `
<output_contract>
Return exactly one JSON object and nothing else. Do not wrap it in markdown.

The object must match this shape:
{
  "verdict": "MERGE" | "CHANGES_REQUESTED",
  "resolve": [{ "commentId": 123, "threadId": "..." }],
  "followUps": [{ "commentId": 123, "body": "..." }],
  "newFindings": [{ "path": "relative/path.ext", "line": 123, "startLine": 120, "body": "..." }],
  "requirementFindings": [{ "issueNumber": 47, "requirement": "Missing requirement.", "evidence": "Why it is missing.", "fix": "How to fix it." }]
}

Rules:
- MERGE requires empty followUps, newFindings, and requirementFindings arrays.
- CHANGES_REQUESTED requires at least one followUp, newFinding, or requirementFinding.
- CLOSE is not allowed in this reconsideration step.
- Omit startLine for single-line findings.
</output_contract>`.trim()

export const editOutputContract = `
<output_contract>
Return exactly one JSON object and nothing else. Do not wrap it in markdown.

The object must match this shape:
{
  "mode": "EDITED" | "REPLIED",
  "commitSha": "full sha, required only when mode is EDITED; omit when mode is REPLIED",
  "commitMessage": "fix(scope): short description, required only when mode is EDITED; omit when mode is REPLIED",
  "filesTouched": ["relative/path.ext"],
  "responses": [{ "commentId": 123, "action": "FIXED" | "DISAGREE" | "ASK", "body": "Fixed." }]
}

Rules:
- Use EDITED only when you edited files, staged changes, and committed.
- Use REPLIED when you only replied without code changes.
- FIXED means you agreed with the reviewer and made a code change.
- DISAGREE means you did not edit because the requested change is incorrect or unnecessary.
- ASK means you did not edit because you need clarification.
- Do not make changes just because a reviewer requested them; edit only when you understand and agree.
- Do not push. The orchestrator pushes after validating this envelope.
- filesTouched must include every final changed file.
- responses must include a reply for each thread you addressed.
- REPLIED requires filesTouched to be empty and at least one DISAGREE or ASK response.
</output_contract>`.trim()

export const ciClassificationOutputContract = `
<output_contract>
Return exactly one JSON object and nothing else. Do not wrap it in markdown.
{
  "checks": [
    {
      "name": "exact failed check name",
      "classification": "SCOPE_IN" | "SCOPE_OUT",
      "reason": "Short reason."
    }
  ]
}
Rules:
- Return one item for every failed check.
- SCOPE_IN means the failure should be treated as caused by the PR changes and passed to reviewers/editor.
- SCOPE_OUT means the failure is likely flaky, external, or infrastructure-related and may be rerun.
- If uncertain, choose SCOPE_IN.
</output_contract>`.trim()

export const ciClassificationAfterEditOutputContract = `
<output_contract>
Return exactly one JSON object and nothing else. Do not wrap it in markdown.
{
  "checks": [
    {
      "name": "exact failed check name",
      "classification": "SCOPE_IN" | "SCOPE_OUT",
      "reason": "Short reason."
    }
  ]
}
Rules:
- Return one item for every failed check.
- SCOPE_IN means the failure should be treated as caused by the PR changes or the editor changes and passed to reviewers/editor.
- SCOPE_OUT means the failure is likely flaky, external, or infrastructure-related and may be rerun.
- If uncertain, choose SCOPE_IN.
</output_contract>`.trim()

export function triageVoteOutputContract(votes: string): string {
  return `
<output_contract>
Return exactly one JSON object and nothing else. Do not wrap it in markdown.

The object must match this shape:
{
  "vote": ${votes},
  "reason": "Short rationale."
}
</output_contract>`.trim()
}

export const triageDuplicateOutputContract = `
<output_contract>
Return exactly one JSON object and nothing else. Do not wrap it in markdown.

The object must match this shape:
{
  "vote": "DUPLICATE" | "NOT_DUPLICATE",
  "duplicateOf": 123,
  "reason": "Short rationale."
}

Rules:
- duplicateOf is required only when vote is DUPLICATE.
- duplicateOf must be one of the provided duplicate candidate issue numbers.
</output_contract>`.trim()

export const triageCommentClassificationOutputContract = `
<output_contract>
Return exactly one JSON object and nothing else. Do not wrap it in markdown.

The object must match this shape:
{
  "comments": [
    {
      "commentId": 123,
      "classification": "OBJECTION" | "NEW_EVIDENCE" | "CLARIFICATION" | "ACKNOWLEDGEMENT" | "UNRELATED",
      "reason": "Short rationale."
    }
  ]
}
</output_contract>`.trim()

export const triageActionOutputContract = `
<output_contract>
Return exactly one JSON object and nothing else. Do not wrap it in markdown.

The object must match this shape:
{
  "action": "ASK" | "COMMENT" | "CLOSE" | "PR" | "CLEAR_ONLY",
  "reason": "Short rationale."
}

Rules:
- Choose only an action listed as allowed in the task context.
- ASK means post an author-mentioned question and do not close, create a PR, or clear labels.
- COMMENT means post a decision comment only.
- CLOSE means post a decision comment and close the issue.
- PR means post a decision comment and create an implementation PR.
- CLEAR_ONLY means clear labels without posting a comment.
</output_contract>`.trim()

const outputContractsBySchemaName: Record<string, string> = {
  "CI classification": ciClassificationOutputContract,
  "close reconsideration": closeReconsiderationOutputContract,
  edit: editOutputContract,
  "finding validation": findingValidationOutputContract,
  rereview: rereviewOutputContract,
  "rereview close reconsideration": rereviewCloseReconsiderationOutputContract,
  review: reviewOutputContract,
  "triage action": triageActionOutputContract,
  "triage acceptance": triageVoteOutputContract('"YES" | "NO" | "ASK"'),
  "triage category": triageVoteOutputContract(
    '"ASK" or one of the configured category IDs',
  ),
  "triage comment classification": triageCommentClassificationOutputContract,
  "triage duplicate": triageDuplicateOutputContract,
  "triage existing PR": triageVoteOutputContract(
    '"RELATED_PR_HANDLES_ISSUE" | "RELATED_PR_DOES_NOT_HANDLE_ISSUE"',
  ),
  "triage reconsider": triageVoteOutputContract('"YES" | "NO" | "ASK"'),
}

export function repairPrompt(schemaName: string): string {
  const outputContract = outputContractsBySchemaName[schemaName]
  const instructions = `Your previous ${schemaName} output did not match the required schema. Regenerate the ${schemaName} result.\n\nReturn only a JSON object matching the output contract below. Do not include analysis, explanation, apologies, markdown, or any text before or after the JSON object.`

  if (!outputContract) return instructions

  return `${instructions}\n\n${outputContract}`
}
