# Scenario Testing Strategy

Scenario tests exercise user-visible command flows with deterministic fake GitHub and model boundaries. Name tests as `scenario: /magi:<command>` and keep command-flow fixtures explicit in the test file.

Automated scenarios should cover orchestration branches where regressions are expensive to find manually:

- `/magi:triage`: category shortcuts, fallback votes, duplicates, related PRs, close automation, PR creation, and reconsideration.
- `/magi:review`: safety gates, review reruns, approval policies, CI handling, and review posting decisions.
- `/magi:merge`: safety gates, approval and close outcomes, edit/rereview cycles, merge queue decisions, CI handling, and thread-resolution limits.

Keep automated scenarios deterministic by injecting fake `exec` functions for `gh`, `git`, and shell commands, and by returning exact model outputs from a fake model client. Scenario tests must run under `pnpm test` without creating or editing GitHub issues, PRs, comments, labels, reviews, branches, or merge queue entries.

Manual or live validation should remain limited to provider behavior that cannot be faithfully unit-tested: GitHub authentication setup, organization permission differences, branch protection or merge queue policy enforcement, real workflow latency, real review-thread resolution side effects, and OpenCode model/session availability.
