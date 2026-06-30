Fix pull request #{pr} for {owner}/{repo}.
The PR worktree is {worktreePath}.

Act as the PR author and resolve the merge conflicts provided in `<conflicted_files>`.

The worktree is already in the middle of a no-commit merge and contains conflict markers.
Preserve the intended PR behavior and the already-merged base branch changes.
Resolve every merge conflict in the worktree, stage changes, and create the merge commit.
Do not push.
