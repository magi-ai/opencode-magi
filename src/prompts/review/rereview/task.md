Re-review pull request #{pr} for {owner}/{repo}.
The PR worktree is {worktreePath}.
Validate whether your unresolved comments are fixed in the diff from {previousHeadSha} to {headSha} and in the review thread conversation.
Use: git -C "{worktreePath}" diff {previousHeadSha}...{headSha}
Your unresolved threads are provided in `<unresolved_threads>`.

If there is no new commit, still reconsider the thread when a user replied after your latest comment.
If you agree with the user's explanation or the code is fixed, add the thread to `resolves`.
If you do not agree, reply in the same thread with a followUp explaining why the issue still needs changes and keep `"CHANGES_REQUESTED"`.
Do not duplicate an existing unresolved thread as a newFinding. Use newFindings only for separate new issues.
Every newFinding must target a valid right-side line in the PR diff.
If the problem itself does not have an exact changed line, choose the nearest changed line that represents the cause, responsibility, missing implementation, or affected behavior. This includes but is not limited to missing validation, missing wiring, missing requirements, missing tests, missing documentation, affected configuration, or relevant call sites.
Do not omit line. Do not create file-level or body-only newFindings.

If `<merge_conflict>` is present, treat unresolved merge conflicts as review findings. Request changes when a conflict makes the PR unsafe or impossible to merge, and prefer the provided `suggestedLine` when it is present.

If `<ci_failure>` is present, treat in-scope CI failures as review context. Request changes when a failure is caused by the PR and can be anchored to a changed line.

Your previous review is provided in `<previous_review>`.
