# Clear

## Usage

```txt
/magi:clear
```

Magi clears all inactive runs.

## What It Does

`/magi:clear` removes inactive Magi run resources: OpenCode child sessions, temporary worktrees, generated branches, and output artifacts.

Active runs are skipped. A run is active when its status is `preparing`, `running`, `blocked`, or `posting`.

## Flow

1. Load `clear.*` defaults from Magi config when available.
2. Select all runs found in memory or under the configured output directory.
3. Skip the run if it is active.
4. Delete child OpenCode sessions when `clear.session` is enabled.
5. Remove the git worktree when `clear.worktree` is enabled.
6. Delete the recorded worktree branch when `clear.branch` is enabled.
7. Delete output artifacts when `clear.output` is enabled.
8. Remove the run from Magi's in-memory tracking and print a summary.

## Outputs

`/magi:clear` prints a cleanup summary with counts for cleared runs, skipped active runs, deleted sessions, removed worktrees, deleted branches, and deleted output directories.

It does not post to GitHub.

## Configuration

Important settings for `/magi:clear`:

| Setting          | Purpose                                  |
| ---------------- | ---------------------------------------- |
| `clear.branch`   | Delete the branch recorded in run state. |
| `clear.output`   | Delete the run output directory.         |
| `clear.session`  | Delete child OpenCode sessions.          |
| `clear.worktree` | Remove the temporary worktree.           |

Each `clear.*` option defaults to `true`. See [Config](/docs/config.md) for the complete configuration reference.

## FAQ

### Will it delete a running merge?

No. Runs with `preparing`, `running`, `blocked`, or `posting` status are skipped.

### What does it clear?

Magi clears all inactive runs it can find in memory or under the configured output directory.

### What branch can be deleted?

Only the branch recorded in run state as the Magi-created worktree branch. Older runs without `worktreeBranch` skip branch deletion.

### Can cleanup resources be disabled?

Yes. Set `clear.output`, `clear.worktree`, `clear.session`, or `clear.branch` to `false` in Magi config.
