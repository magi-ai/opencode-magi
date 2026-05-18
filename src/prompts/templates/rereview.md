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

{ciFailureContextBlock}
Do not edit files or perform write operations.

{previousReviewBlock}
