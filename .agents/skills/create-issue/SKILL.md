---
name: create-issue
description: Create GitHub issues for opencode-magi. Use when asked to create, draft, file, open, or submit an issue, bug report, task, or feature request.
---

## Input

Use the user's request text, and any command arguments if provided, as the initial issue context.

Ask only for missing information that is needed to create a good issue.

- Ask about required template fields only when they cannot be inferred.
- Ask about optional fields only when they materially improve the issue.
- Ask whether the user will work on the issue if that is unclear.
- For bugs, collect environment details only when the selected template requires them. Use local commands only for issues about the current local environment; do not guess the user's environment.
- If ambiguity changes the issue type or meaning, clarify before drafting.

## Type Selection

Every issue must use exactly one GitHub Issue Type: `Bug`, `Task`, or `Feature`.

- `Bug`: broken behavior, unexpected results, documentation drift, workflow failures, or mismatches between expected and actual behavior.
- `Feature`: new user-facing behavior, enhancements to existing behavior, or new APIs/configuration.
- `Task`: internal maintenance that is not a bug or feature, such as AGENTS.md improvements, GitHub workflow cleanup, documentation organization, or repository operations.

Choose the type yourself when the request is clear. Ask the user to choose `Bug`, `Task`, or `Feature` only when you cannot determine it.

## References

Read only the files needed for the selected issue.

- Rules: `.agents/rules/issue.md`
- `Bug`: `.github/ISSUE_TEMPLATE/bug_report.yml`
- `Feature`: `.github/ISSUE_TEMPLATE/feature_request.yml`
- `Task`: `.github/ISSUE_TEMPLATE/task.yml`

Build the issue body from the selected template. Do not keep a fixed field list in this skill.

## Workflow

1. Extract the useful information from the user's request and ask only for essential missing details.
2. Select the issue type, asking the user only if you cannot determine it.
3. Read `.agents/rules/issue.md` and the template for the selected type.
4. Search open and closed issues for likely duplicates.
5. If likely duplicates exist, show them to the user and ask whether to continue.
6. Draft the title, body, labels, and assignee decision from the selected template.
7. Show a concise confirmation summary before submitting: title, issue type, labels, assignee decision, and a 2-3 bullet issue summary. Do not paste the full issue body unless the user asks to review it.
8. Create the issue, then set and verify the GitHub Issue Type.
9. Report the issue URL and Issue Type.
10. Ask: "Do you want to create the PR for this issue now?"

## Template Handling

Follow the selected issue template. Prioritize required fields and include optional fields only when useful.

When this skill creates the issue, the `AI used` section must be:

```markdown
## AI used

- [ ] I did not use AI to create this issue.
- [x] (If there is no check above) I checked the generated content before submitting.
```

## Assignment

Following the selected template, ask whether the user will work on the issue. If they will, assign `@me` when possible.

If assignment fails because of permissions or repository settings, continue creating the issue and report the assignment failure.

## Gotchas

- Do not create an issue without a `Bug`, `Task`, or `Feature` type.
- Do not skip user confirmation before submitting the issue; keep the confirmation concise unless the user asks for the full body.
- Pass the issue body through a temporary file. Do not pass bodies with backticks or other shell-sensitive text as inline command strings.
- Do not assume `gh issue create` set the Issue Type. Verify it after creation and set it with GraphQL if needed.
- If the user chooses to create a PR, read this repository's branch, commit, and PR rules before creating it.
