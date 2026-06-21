<p align='center'>
  English | <a href='./README.ja.md'>日本語</a>
</p>

# OpenCode Magi

Multi-agent GitHub pull request review and merge orchestration for OpenCode.

## Why Magi?

Magi is inspired by the three wise men: independent perspectives that gather and make decisions together.

One AI model is still not enough to trust blindly. OpenCode Magi improves confidence by asking multiple models to inspect the same pull request from different perspectives, then requiring a majority decision.

Instead of treating one AI answer as the final judgment, the goal is to make AI review closer to a real team through diverse viewpoints, explicit disagreement, and final decisions backed by consensus.

## Features

OpenCode Magi recreates the review cycle humans already run on GitHub. Multiple reviewers inspect a pull request, request changes, verify fixes, resolve threads, and approve when the work is ready.

- Multi-agent reviews with majority voting by 3 or more reviewers.
- Majority voting before posting change requests, so only findings accepted by the majority are requested.
- Single mode by default, plus multi mode for using multiple GitHub accounts. In multi mode, each reviewer can review from a different GitHub account, as if a team were reviewing together.
- Re-review support for PRs with edits or thread replies. Fixed threads are resolved, reviewers approve based on fixes, and findings that still need changes are posted as additional comments.
- Optional merge and close automation. An editor agent responds on behalf of the author, fixes requested findings, pushes commits when needed, and repeats the reviewer/editor cycle until the PR can be merged or closed.
- Configure permissions, phase-specific prompts, and personas for each reviewer and editor.

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

Magi config files are merged by OpenCode Magi, not by OpenCode. The project config file overrides the global config file.

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

By default, Magi uses single mode (`mode: "single"`). To use multi mode with multiple GitHub accounts, set `mode: "multi"` and configure an account for each reviewer.

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

Set an `agents.refs` key as `ref` to expand that agent's configuration. Fields set outside `ref` override that agent's configuration.

`model` can be a string (`provider/model`), an object with `id` and `variant`, or an array. Arrays are checked in order to find an available model, and the first available model is selected.

```json
{
  "model": {
    "id": "openai/gpt-5.1",
    "variant": "high"
  }
}
```

```json
{
  "model": [
    { "id": "anthropic/claude-opus-4-7", "variant": "high" },
    { "id": "openai/gpt-5.5", "variant": "medium" }
  ]
}
```

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

- [Commands](docs/commands/index.en.md)
- [Config](docs/config.en.md)
- [Prompts](docs/prompts/index.en.md)

## Contributing

Wouldn't you like to contribute? That's amazing! We have prepared a [contribution guide](CONTRIBUTING.md) to assist you.
