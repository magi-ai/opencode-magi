# OpenCode Magi

Multi-agent GitHub pull request review and merge orchestration for OpenCode.

## Why Magi?

Magi is inspired by the three wise men: independent perspectives that reach a decision together.

One AI model is still not enough to trust blindly. OpenCode Magi improves confidence by asking multiple models to inspect the same pull request from different perspectives, then requiring an odd-number majority before approving, requesting changes, or closing.

The goal is not to treat a single AI answer as final, but to make AI review behave more like a real team: diverse viewpoints, explicit disagreement, and a final decision backed by consensus.

## Features

OpenCode Magi recreates the review cycle humans already run on GitHub: multiple reviewers inspect a pull request, request changes, verify fixes, resolve threads, and approve when the work is ready.

- Multi-agent reviews with an odd-number majority of 3 or more reviewers.
- Optional unanimous approval policy for merge automation when every reviewer must approve before a PR is merged.
- Finding-level voting before posting change requests, so only findings accepted by reviewer majority are submitted.
- Multi-account review mode where each reviewer posts through its configured GitHub account, plus single-account review mode where one GitHub account posts the consensus result for multiple logical reviewers.
- Re-review support for edited PRs: fixed threads are resolved, satisfied reviewers approve, and remaining issues are posted as additional comments.
- Optional merge and close automation where an editor agent responds on behalf of the author, fixes changes it agrees with, pushes commits when needed, and repeats the reviewer/editor cycle until the PR can be approved, queued, merged, or closed.
- Per-agent OpenCode permissions for reviewer, CI classifier, and editor child sessions.
- Prompt customization that adds repository-specific guidance without replacing the fixed output contracts.

## Quick Start

### Install

Add the plugin to `opencode.json`.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-magi"]
}
```

Restart OpenCode. Done.

### Configure

Configure global defaults in `~/.config/opencode/magi.json` and project overrides in `<project>/.opencode/magi.json`.

Magi config files are merged by OpenCode Magi, not by OpenCode. Priority, lowest to highest.

1. `~/.config/opencode/magi.json`
2. `<project>/.opencode/magi.json`

#### Set global config

You do not need to set global config values if the settings exist in your project config. However, using the global config is useful when you want to apply shared values across multiple projects.

```bash
mkdir -p ~/.config/opencode
touch ~/.config/opencode/magi.json
```

Add the following content to the configuration file.

```json
{
  "$schema": "https://raw.githubusercontent.com/magi-ai/opencode-magi/main/schema.json",
  "agents": {
    "refs": {
      "account-1": {
        "model": "openai/gpt-5.5",
        "account": "account-1"
      },
      "account-2": {
        "model": "anthropic/claude-opus-4-7",
        "account": "account-2"
      },
      "account-3": {
        "model": "opencode/kimi-k2-6",
        "account": "account-3"
      }
    }
  },
  "review": {
    "reviewers": [
      { "ref": "account-1" },
      { "ref": "account-2" },
      { "ref": "account-3" }
    ]
  }
}
```

After `refs` are expanded, `review.reviewers[].account` is the GitHub account used to post reviews and approvals in the default `review.mode: "multi"`. Must be authenticated with `gh auth token --user <account>` and must be unique.

For individual setups, use `review.mode: "single"` with one `review.account`. Magi still runs an odd number of at least 3 logical reviewer agents and keeps majority voting, finding validation, and close reconsideration, but GitHub branch protection sees only the one configured review account.

```json
{
  "review": {
    "mode": "single",
    "account": "your-account",
    "reviewers": [
      { "id": "general", "model": "openai/gpt-5.5" },
      { "id": "security", "model": "anthropic/claude-opus-4-7" },
      { "id": "compat", "model": "opencode/kimi-k2-6" }
    ]
  }
}
```

#### Set project config

Global config is optional, but project config is required.

```bash
cd <project>
mkdir -p .opencode
touch .opencode/magi.json
```

Add the following content to the configuration file.

```json
{
  "$schema": "https://raw.githubusercontent.com/magi-ai/opencode-magi/main/schema.json",
  "github": {
    "owner": "your-owner",
    "repo": "your-repo"
  },
  "agents": {
    "refs": {
      "account-1": {
        "model": "openai/gpt-5.5",
        "account": "account-1"
      },
      "account-2": {
        "model": "anthropic/claude-opus-4-7",
        "account": "account-2"
      },
      "account-3": {
        "model": "opencode/kimi-k2-6",
        "account": "account-3"
      },
      "account-4": {
        "model": "openai/gpt-5.5",
        "account": "account-4",
        "author": {
          "name": "account-4",
          "email": "your-email@example.com"
        }
      }
    }
  },
  "review": {
    "reviewers": [
      { "ref": "account-1" },
      { "ref": "account-2" },
      { "ref": "account-3" }
    ]
  },
  "merge": {
    "editor": { "ref": "account-4" }
  },
  "triage": {
    "voters": [
      { "ref": "account-1" },
      { "ref": "account-2" },
      { "ref": "account-3" }
    ]
  }
}
```

Entries with `ref` are expanded from `agents.refs`. Fields set alongside `ref` override fields from the preset.

`model` can be a single `provider/model` string, a single object with `id` and `options`, or an ordered candidate array. Candidate arrays are resolved during validation against OpenCode's model catalog; the first available model is selected. Put provider-specific options on model objects, not on the agent role.

```json
{
  "model": {
    "id": "openai/gpt-5.1",
    "options": { "reasoningEffort": "high" }
  }
}
```

After `refs` are expanded, `review.reviewers[].account` is the GitHub account used to post reviews and approvals in `multi` mode. Must be authenticated with `gh auth token --user <account>` and must be unique. In `single` mode, `review.account` is used for reviewer-originated review posts, approvals, change requests, close comments, reviewer replies, and reviewer thread resolutions. `merge.editor.account` is still used by `/magi:merge` to push fixes, close PRs, and merge PRs.

#### Validate config

After creating or updating your global or project configuration, validate it.

```txt
/magi:validate
```

### Commands

Run commands from OpenCode.

```txt
/magi:review 123 124
/magi:review --dry-run 123
/magi:merge 123
/magi:merge --dry-run 123
/magi:triage 47 48
/magi:triage --dry-run 47
/magi:clear
```

## Docs

- [Commands](docs/commands/index.md)
- [Config](docs/config.md)
- [Prompts](docs/prompts/index.md)

## Contributing

Wouldn't you like to contribute? That's amazing! We have prepared a [contribution guide](CONTRIBUTING.md) to assist you.
