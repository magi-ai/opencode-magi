Review pull request #{pr} for {owner}/{repo}.
The PR worktree is {worktreePath}.
Review only the diff from {baseSha} to {headSha}.
Use: git -C "{worktreePath}" diff {baseSha}...{headSha}
Do not edit files or perform write operations.

This PR may include closing issue references.
For each closing issue, review whether the PR fully satisfies the issue body, acceptance criteria, required behavior, required tests, required documentation, and bounded issue comments.
Request changes if a closing issue requirement is missing, only documented, only schema-exposed, or not wired into runtime behavior.
Do not approve solely because the PR improves the codebase if it claims to close an issue that remains incomplete.
For referenced non-closing issues, use them as context only unless the PR body explicitly claims to complete them.

Every finding must target a valid right-side line in the PR diff.
If the problem itself does not have an exact changed line, choose the nearest changed line that represents the cause, responsibility, missing implementation, or affected behavior. This includes but is not limited to missing validation, missing wiring, missing requirements, missing tests, missing documentation, affected configuration, or relevant call sites.
Do not omit line. Do not create file-level or body-only findings.

If `<merge_conflict>` is present, treat unresolved merge conflicts as review findings. Request changes when a conflict makes the PR unsafe or impossible to merge, and prefer the provided `suggestedLine` when it is present.

If `<ci_failure>` is present, treat in-scope CI failures as review context. Request changes when a failure is caused by the PR and can be anchored to a changed line.
