Re-review pull request #{pr} for {owner}/{repo}.
The PR worktree is {worktreePath}.
Validate whether your unresolved comments are fixed in the diff from {previousHeadSha} to {headSha} and in the review thread conversation.
Use: git -C {jsonEncodedWorktreePath} diff {previousHeadSha}...{headSha}
Your unresolved threads are provided as JSON below.
{unresolvedThreads}

If there is no new commit, still reconsider the thread when a user replied after your latest comment.
If you agree with the user's explanation or the code is fixed, resolve the thread.
If you do not agree, reply in the same thread with a followUp explaining why the issue still needs changes and keep CHANGES_REQUESTED.
Do not duplicate an existing unresolved thread as a newFinding. Use newFindings only for separate new issues.
Every newFinding must target a valid right-side line in the PR diff.
If the problem itself does not have an exact changed line, choose the nearest changed line that represents the cause, responsibility, missing implementation, or affected behavior. This includes but is not limited to missing validation, missing wiring, missing requirements, missing tests, missing documentation, affected configuration, or relevant call sites.
Do not omit line. Do not create file-level or body-only newFindings.

{ciFailureContextBlock}
Do not edit files or perform write operations.

{previousReviewBlock}
