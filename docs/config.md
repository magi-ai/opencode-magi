<p align='center'>
  English | <a href='config.ja.md'>日本語</a>
</p>

# Config

Set global defaults in `~/.config/opencode/magi.json`, and project-specific overrides in `<project>/.opencode/magi.json`.

Magi config files are merged by OpenCode Magi, not by OpenCode. The project config file overrides the global config file.

1. `~/.config/opencode/magi.json`
2. `<project>/.opencode/magi.json`

## Validate

Run `/magi:validate` in OpenCode to validate config content, authentication status, and model availability.

```txt
/magi:validate
```

## Examples

### Global Config

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
      {
        "ref": "account-1"
      },
      {
        "ref": "account-2"
      },
      {
        "ref": "account-3"
      }
    ]
  }
}
```

### Project Config

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
      {
        "ref": "account-1"
      },
      {
        "ref": "account-2"
      },
      {
        "ref": "account-3"
      }
    ]
  },
  "merge": {
    "editor": {
      "ref": "account-4"
    }
  },
  "triage": {
    "voters": [
      {
        "ref": "account-1"
      },
      {
        "ref": "account-2"
      },
      {
        "ref": "account-3"
      }
    ]
  }
}
```

## Reference

Set an `agents.refs` key as `ref` to expand that agent configuration. Fields set alongside `ref` override the referenced agent configuration.

```json
{
  "agents": {
    "refs": {
      "gpt-5.5": {
        "model": {
          "id": "openai/gpt-5.5",
          "variant": "high"
        }
      }
    }
  },
  "review": {
    "reviewers": [
      {
        "ref": "gpt-5.5",
        "account": "account-1"
      },
      {
        "ref": "gpt-5.5",
        "account": "account-2"
      }
    ]
  }
}
```

## Models

`model` can be a string (`provider/model`), an object with `id` and `variant`, or an array. Arrays are checked in order, and the first available model is used.

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
    {
      "id": "anthropic/claude-opus-4-7",
      "variant": "high"
    },
    {
      "id": "openai/gpt-5.5",
      "variant": "medium"
    }
  ]
}
```

## Permissions

Set `agents.permissions` to configure permissions shared by all agents. Each agent's `permissions` overrides `agents.permissions`.

```json
{
  "agents": {
    "permissions": {
      "read": "allow",
      "edit": "deny",
      "bash": {
        "*": "deny",
        "git status*": "allow",
        "git diff*": "allow"
      }
    }
  },
  "review": {
    "reviewers": [
      {
        "id": "security",
        "model": "anthropic/claude-opus-4-7",
        "permissions": {
          "webfetch": "allow"
        }
      }
    ]
  }
}
```

You can set `allow`, `ask`, or `deny`. A string applies to the entire target permission, while an object configures allow, ask, or deny per pattern.

## Multi Mode

By default, Magi runs in single mode (`mode: "single"`). To use multiple GitHub accounts, set `mode: "multi"` and configure an account for each agent.

Accounts must be unique within `review.reviewers` and `triage.voters`, but may be reused between roles.

```json
{
  "mode": "multi",
  "review": {
    "reviewers": [
      {
        "id": "general",
        "model": "openai/gpt-5.5",
        "account": "account-1"
      },
      {
        "id": "security",
        "model": "anthropic/claude-opus-4-7",
        "account": "account-2"
      },
      {
        "id": "compat",
        "model": "opencode/kimi-k2-6",
        "account": "account-3"
      }
    ]
  }
}
```
