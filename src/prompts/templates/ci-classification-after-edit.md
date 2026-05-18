Classify failed CI jobs after editor changes for pull request #{pr} in {owner}/{repo}.
This is edit cycle {cycle}.

The editor changed the PR from {previousHeadSha} to {headSha}.
The PR worktree is {worktreePath}.
Use this diff for context: git -C {jsonEncodedWorktreePath} diff {previousHeadSha}...{headSha}

Decide whether each failure is caused by the PR/editor changes or is likely flaky, external, or infrastructure-related.
Treat failures that appeared after the editor changes as SCOPE_IN unless there is strong evidence they are unrelated.
If uncertain, choose SCOPE_IN.

Failed checks with structured failure evidence:

```json
{failedChecks}
```
