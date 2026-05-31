# OpenCode Magi

This is test.

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
- Single-account identity mode by default, where one GitHub account posts consensus-backed review and triage results for multiple logical agents, plus multi-account mode for setups that need separate GitHub identities.
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
  "account": "your-account",
  "agents": {
    "refs": {
      "account-1": {
        "model": "openai/gpt-5.5"
      },
      "account-2": {
        "model": "anthropic/claude-opus-4-7"
      },
      "account-3": {
        "model": "opencode/kimi-k2-6"
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

By default, `mode` is `"single"`. Magi uses one top-level `account` to post reviewer- and triage-originated GitHub mutations while still running multiple logical agents and preserving majority voting, finding validation, and close reconsideration. The account must be authenticated with `gh auth token --user <account>`.

For advanced team setups that need GitHub to see separate review or triage identities, set top-level `mode: "multi"` and configure unique accounts for each reviewer or triage voter.

```json
{
  "mode": "multi",
  "review": {
    "reviewers": [
      { "id": "general", "model": "openai/gpt-5.5", "account": "account-1" },
      {
        "id": "security",
        "model": "anthropic/claude-opus-4-7",
        "account": "account-2"
      },
      { "id": "compat", "model": "opencode/kimi-k2-6", "account": "account-3" }
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
  "account": "your-account",
  "github": {
    "owner": "your-owner",
    "repo": "your-repo"
  },
  "agents": {
    "refs": {
      "account-1": {
        "model": "openai/gpt-5.5"
      },
      "account-2": {
        "model": "anthropic/claude-opus-4-7"
      },
      "account-3": {
        "model": "opencode/kimi-k2-6"
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

After `refs` are expanded, top-level `account` is the GitHub account used for reviewer- and triage-originated posts and mutations in `single` mode. In `multi` mode, `review.reviewers[].account` and `triage.voters[].account` are used instead and must be unique within their agent lists. `merge.editor.account` is still used by `/magi:merge` to push fixes, close PRs, and merge PRs.

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
