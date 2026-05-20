# PR Merge Guidelines

## Branch Protection Rules

The following branch protection rules are enabled on the `main` branch. Always verify them before merging.

### Pull Request

- **Require a pull request before merging**: Direct pushes are not allowed. Changes must go through a PR.
- **Required approvals**: At least 1 approval is required.
- **Dismiss stale pull request approvals when new commits are pushed**: Any new commit dismisses existing approvals. A re-review is required.

### Review

- **Require review from Code Owners**: Approval from a Code Owner listed in [CODEOWNERS](/.github/CODEOWNERS) is required.
- **Require conversation resolution before merging**: All review comments and conversations must be resolved before merging.

### Status Checks

- **Require status checks to pass**: All of the following required status checks must be green. The same checks run on both `pull_request` and `merge_group` events under the same names, and both are required.
  - Lint
  - Format
  - Build
  - Typecheck
  - Test

### Merge Queue

The queue creates an internal merge candidate against the latest base, re-runs the same Quality jobs on a `merge_group` event, and merges only after they pass. If a required check fails on the merge candidate, the PR is removed from the queue and returned to its original state, and the author must address the failure and re-queue the PR.
