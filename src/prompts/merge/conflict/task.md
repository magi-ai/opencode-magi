Resolve merge conflicts for pull request #{pr} in {owner}/{repo}.
The PR worktree is {worktreePath}.

The latest base branch is {baseBranch} at {baseSha}.
The PR head before conflict recovery was {headSha}.

Conflicted files:
{conflictedFiles}

Resolve every merge conflict in the worktree. Preserve the intended PR behavior while incorporating the latest base branch changes. Stage all resolved files and create a commit. Do not push.
