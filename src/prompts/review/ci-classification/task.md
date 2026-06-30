Classify failed CI jobs for pull request #{pr} in {owner}/{repo}.
Decide whether each failure is caused by the PR changes or is likely flaky, external, or infrastructure-related.
The PR worktree is {worktreePath}.
Review only the diff from {baseSha} to {headSha}.
Use: git -C "{worktreePath}" diff {baseSha}...{headSha}

Failed checks with structured failure evidence are provided in `<failed_checks>`.
