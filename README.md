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
- Each reviewer acts through its configured GitHub account, posting real reviews, approvals, change requests, and follow-up comments.
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
  "$schema": "https://raw.githubusercontent.com/hirotomoyamada/opencode-magi/main/schema.json",
  "agents": {
    "reviewers": [
      {
        "account": "your-account-1",
        "model": "openai/gpt-5.5"
      },
      {
        "account": "your-account-2",
        "model": "anthropic/claude-opus-4-7"
      },
      {
        "account": "your-account-3",
        "model": "opencode/kimi-k2-6"
      }
    ]
  }
}
```

`agents.reviewers[].account` is the GitHub account used to post reviews and approvals. Must be authenticated with `gh auth token --user <account>` and must be unique.

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
  "$schema": "https://raw.githubusercontent.com/hirotomoyamada/opencode-magi/main/schema.json",
  "github": {
    "owner": "your-owner",
    "repo": "your-repo"
  },
  "agents": {
    "reviewers": [
      {
        "account": "your-account-1",
        "model": "openai/gpt-5.5"
      },
      {
        "account": "your-account-2",
        "model": "anthropic/claude-opus-4-7"
      },
      {
        "account": "your-account-3",
        "model": "opencode/kimi-k2-6"
      }
    ],
    "editor": {
      "account": "your-editor-account",
      "model": "openai/gpt-5.5",
      "author": {
        "name": "your-account",
        "email": "your-email@example.com"
      }
    }
  }
}
```

`agents.reviewers[].account` is the GitHub account used to post reviews and approvals. Must be authenticated with `gh auth token --user <account>` and must be unique.

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
/magi:clear
```

## Docs

- [Commands](docs/commands/index.md)
- [Config](docs/config.md)
- [Prompts](docs/prompts.md)

## Contributing

Wouldn't you like to contribute? That's amazing! We have prepared a [contribution guide](CONTRIBUTING.md) to assist you.
