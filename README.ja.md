<p align='center'>
  <a href='./README.md'>English</a> | 日本語
</p>

# OpenCode Magi

OpenCodeのマルチエージェントによるGitHubプルリクエストレビューとマージのオーケストレーション。

## なぜ、Magiなのか？

Magiは、三賢者に着想を得ています。独立した視点が集まり、共に意思決定する仕組みです。

1つのAIモデルだけを盲目的に信頼するには、まだ十分ではありません。OpenCode Magiは、複数のモデルに同じプルリクエストを異なる視点から検査させ、過半数を必須にすることで信頼性を高めます。

一つのAIの回答を最終判断として扱うことせず、多様な観点、明示的な意見の不一致、そして合意に裏付けられた最終判断によって、AIレビューを実際のチームに近づけることです。

## 機能

OpenCode Magiは、人間がGitHub上で行っているレビューサイクルを再現します。複数のレビュアーがプルリクエストを確認し、変更を要求し、修正を検証し、スレッドを解決し、準備ができたら承認します。

- 3人以上のレビュアーによる、多数決制のマルチエージェントレビュー。
- 変更リクエストを投稿する前に多数決を行い、過半数に承認された指摘だけをリクエストします。
- デフォルトのシングルモードに加え、複数のGitHubアカウントを使用するマルチモードも用意しています。マルチモードでは、まるでチームでレビューを行っているかのように、各レビュアーが異なるGitHubアカウントでレビューを行うことができます。
- 編集やスレッドの返信があるPRの再レビューに対応。修正済みのスレッドを解決し、修正に応じてレビュアーは承認し、まだ修正が必要な指摘は追加のコメントとして投稿します。
- 任意のマージおよびクローズ自動化。エディターエージェントが作者の代わりに応答し、変更リクエストされた指摘を修正し、必要に応じてコミットをプッシュし、PRがマージ、またはクローズできるまでレビュアーとエディターのサイクルを繰り返します。
- レビュアーやエディターごとに権限の割り振り、フェーズごとのプロンプト、ペルソナを設定できます。

## クイックスタート

### インストール

`opencode.json`にプラグインを追加します。

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-magi"]
}
```

OpenCodeを再起動します。これで完了です。

### 設定

グローバルのデフォルトは `~/.config/opencode/magi.json`に、プロジェクトごとの上書きは、`<project>/.opencode/magi.json`に設定します。

Magiの設定ファイルは、OpenCodeではなくOpenCode Magiによってマージされます。プロジェクトの設定ファイルは、グローバルの設定ファイルをオーバーライドします。

1. `~/.config/opencode/magi.json`
2. `<project>/.opencode/magi.json`

#### グローバル設定を作成する

プロジェクト設定に値が存在する場合、グローバル設定値を設定する必要はありません。ただし、複数のプロジェクトで共通の値を適用したい場合は、グローバル設定が便利です。

```bash
mkdir -p ~/.config/opencode
touch ~/.config/opencode/magi.json
```

設定ファイルに次の内容を追加します。

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

デフォルトでは、シングルモード（`mode: "single"`）です。複数のGitHubアカウントを使用するマルチモードにする場合は、`mode: "multi"`を設定し、各レビュアーごとにアカウントを設定します。

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

#### プロジェクト設定を作成する

Magiの設定ファイルは少なくとも1つ必要です。プロジェクト固有の設定には、プロジェクト設定を使用します。

```bash
cd <project>
mkdir -p .opencode
touch .opencode/magi.json
```

設定ファイルに次の内容を追加します。

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

`agents.refs`のキーを`ref`に設定すると、そのエージェントの設定が展開されます。`ref`以外でフィールドを設定した場合は、そのエージェントの設定をオーバーライドします。

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
    { "id": "anthropic/claude-opus-4-7", "variant": "high" },
    { "id": "openai/gpt-5.5", "variant": "medium" }
  ]
}
```

#### 設定を検証する

グローバル設定またはプロジェクト設定を作成または更新した後、検証します。

```txt
/magi:validate
```

### コマンド

OpenCodeからコマンドを実行します。

```txt
/magi:review 123 124
/magi:review 123 --dry-run
/magi:merge 123
/magi:merge 123 --dry-run
/magi:triage 47 48
/magi:triage 47 --dry-run
/magi:clear
```

## ドキュメント

- [コマンド](docs/commands/index.ja.md)
- [設定](docs/config.ja.md)

## コントリビュート

貢献してみませんか？素晴らしいです！貢献を支援するための [コントリビューションガイド](CONTRIBUTING.ja.md) を用意しています。
