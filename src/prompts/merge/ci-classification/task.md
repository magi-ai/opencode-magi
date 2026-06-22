Classify failed CI jobs after editor changes for pull request #{pr} in {owner}/{repo}.
Decide whether each failure is caused by the PR changes or the editor changes, or is likely flaky, external, or infrastructure-related.
The PR worktree is {worktreePath}.
Review only the diff from {baseSha} to {headSha}.
Use: git -C "{worktreePath}" diff {baseSha}...{headSha}

Treat failures that appeared after the editor changes as `"SCOPE_IN"` unless there is strong evidence they are unrelated.
If uncertain, choose `"SCOPE_IN"`.

Failed checks with structured failure evidence:

```json
{failedChecks}
```
