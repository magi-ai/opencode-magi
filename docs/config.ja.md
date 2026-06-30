<p align='center'>
  <a href='config.md'>English</a> | 日本語
</p>

# 設定

グローバルのデフォルトは `~/.config/opencode/magi.json`に、プロジェクトごとの上書きは、`<project>/.opencode/magi.json`に設定します。

Magiの設定ファイルは、OpenCodeではなくOpenCode Magiによってマージされます。プロジェクトの設定ファイルは、グローバルの設定ファイルをオーバーライドします。

1. `~/.config/opencode/magi.json`
2. `<project>/.opencode/magi.json`

## 検証

`/magi:validate`で設定内容、認証状態、モデルが使用可能かどうかを検証できます。OpenCodeで次のコマンドを実行します。

```txt
/magi:validate
```

## 例

### グローバル設定

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

### プロジェクト設定

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

## リファレンス

`agents.refs`のキーを`ref`に設定すると、そのエージェントの設定が展開されます。`ref`以外でフィールドを設定した場合は、そのエージェントの設定をオーバーライドします。

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

## モデル

`model`には、文字列（`provider/model`）、`id`と`variant`のオブジェクト、または配列を指定できます。配列は、先頭から順々に利用可能なモデルかどうかを検証し、利用可能なモデルが見つかったら、そのモデルを採用します。

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

## パーミッション

`agents.permissions`ですべてのエージェントに共通したパーミッションを設定できます。個々のエージェントの`permissions`は、`agents.permissions`をオーバーライドします。

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

`allow`、`ask`、`deny`を設定できます。文字列を指定すると対象権限全体に適用され、オブジェクトを指定するとパターンごとに許可・確認・拒否を設定できます。

## マルチモード

デフォルトでは、シングルモード（`mode: "single"`）です。複数のGitHubアカウントを使用するマルチモードにする場合は、`mode: "multi"`を設定し、各エージェントごとにアカウントを設定します。

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
