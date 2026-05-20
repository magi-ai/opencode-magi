Review pull request #{pr} for {owner}/{repo}.
The PR worktree is {worktreePath}.
Review only the diff from {baseSha} to {headSha}.
Use: git -C {jsonEncodedWorktreePath} diff {baseSha}...{headSha}
Do not edit files or perform write operations.

This PR may include closing issue references.
For each closing issue, review whether the PR fully satisfies the issue body, acceptance criteria, required behavior, required tests, required documentation, and bounded issue comments.
Request changes if a closing issue requirement is missing, only documented, only schema-exposed, or not wired into runtime behavior.
Do not approve solely because the PR improves the codebase if it claims to close an issue that remains incomplete.
For referenced non-closing issues, use them as context only unless the PR body explicitly claims to complete them.

{ciFailureContextBlock}
