# /magi:triage

## Usage

```txt
/magi:triage <ISSUE...>
/magi:triage --dry-run <ISSUE...>
```

`<ISSUE...>` accepts one or more issue numbers, `#123` tokens, or issue URLs separated by spaces or commas.

## What It Does

`/magi:triage` triages GitHub issues with dedicated `triage.agents`. It does not reuse `review.agents`.

Magi fetches bounded issue relationship data, asks triage agents to vote on existing PRs, duplicate issues, issue kind, and bug or feature decisions, then posts one author-mentioned result comment through `triage.account` unless the run is a clear-only linked PR case.

## Flow

1. Parse issue arguments and load `triage.*` config.
2. Check issue safety gates such as required labels and blocked labels.
3. Scan bounded relationships: related PRs, duplicate candidates, and previous Magi markers.
4. Vote whether related PRs already handle the issue.
5. Vote whether duplicate candidates are true duplicates.
6. Resolve issue kind from `triage.kind.*` labels/types or run Kind Vote.
7. Run Bug Vote or Feature Vote.
8. Compose an author-mentioned comment or question.
9. Apply enabled automation: close, PR creation, and label clearing.
10. Write artifacts and a report.

`ASK` is a normal result. It posts a question comment and does not close, create PRs, or clear labels.

## Configuration

Important settings:

| Setting                   | Purpose                                                 |
| ------------------------- | ------------------------------------------------------- |
| `triage.account`          | GitHub account used for triage comments and mutations.  |
| `triage.agents`           | Dedicated issue triage voting agents.                   |
| `triage.creator`          | Agent used for implementation PR creation when enabled. |
| `triage.kind.*`           | Label/type rules that can skip Kind Vote.               |
| `triage.automation.close` | Enables closing rejected or duplicate issues.           |
| `triage.automation.pr`    | Enables implementation PR creation for accepted issues. |
| `triage.automation.clear` | Labels removed for non-ASK results.                     |
| `triage.safety.*`         | Gates for initial triage and reconsideration.           |
| `triage.concurrency.runs` | Maximum issues processed concurrently.                  |
| `triage.output`           | Issue triage artifact directory.                        |
| `triage.worktree`         | Worktree directory for validation and PR creation.      |

See [Config](/docs/config.md) for the complete reference.
