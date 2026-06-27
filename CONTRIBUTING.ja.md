## OpenCode Magiへの貢献に関心を持ってくれて、ありがとうございます😎 あなたは素晴らしいです！！！

オープンソースへの貢献は、いくつかの方法で行うことができ、すべてが価値あるものです。これらは、あなたが貢献を準備する際に役立つガイドラインです。

## プロジェクトのセットアップ

以下の手順で、OpenCode Magiへの貢献を始められるようになります。

1. [リポジトリ](https://github.com/magi-ai/opencode-magi)をフォークします。

2. あなたのローカルにクローンします。

```sh
git clone https://github.com/<your_github_username>/opencode-magi.git

cd opencode-magi
```

3. Node.js（`>=24.14`）と pnpm（`10.33.0`）をインストールします。

4. `pnpm install`を実行して、すべての依存関係をセットアップします。

## 開発

OpenCode Magiは、OpenCodeのマルチエージェントによるGitHubのPRのレビューとマージのオーケストレーションプラグインです。

このプロジェクトは意図的に小さく保たれているため、貢献は焦点を絞ったものにしてください。変更作業中に別の問題を見つけた場合は、複数の修正をまとめずに、別のイシューまたはPRを開いてください。

### ツール

- [PNPM](https://pnpm.io/): パッケージと依存関係の管理。
- [tsgo](https://github.com/microsoft/typescript-go): TypeScriptの型チェックとビルド。
- [oxfmt](https://github.com/oxc-project/oxc): コードフォーマット。
- [oxlint](https://github.com/oxc-project/oxc): コード lint
- [Vitest](https://vitest.dev/): ユニットテストの実行
- [Lefthook](https://lefthook.dev/): Git フックの実行
- [Changesets](https://github.com/changesets/changesets): changelog とリリース管理

### コマンド

- **`pnpm install`**: 依存関係をインストールし、Gitフックを準備します。
- **`pnpm build`**: ビルドを実行します。
- **`pnpm test`**: テストを実行します。
- **`pnpm quality`**: フォーマットチェック、ルールチェック、型チェック、テストを実行します。
- **`pnpm format:check`**: フォーマットのチェックを実行します。
- **`pnpm lint:check`**: ルールのチェックを実行します。
- **`pnpm typecheck`**: 型のチェックを実行します。
- **`pnpm release:dev`**: 開発パッケージを公開します。
- **`pnpm release`**: パッケージを公開します。

## AI 利用ポリシー

OpenCode Magiは、人工知能（AI）ツールの支援を活用した貢献を含め、すべての方からの貢献を歓迎します。AIを用いて貢献を行う場合は、以下の[AI利用ポリシー](AI_POLICY.ja.md)に従ってください。

## バグを見つけたと思いますか？

[テンプレート](https://github.com/magi-ai/opencode-magi/issues/new?template=bug_report.yml)に従って、提供してください。

## 新規または変更のAPIを提案しますか？

[テンプレート](https://github.com/magi-ai/opencode-magi/issues/new?template=feature_request.yml)に従って、提供してください。

## プルリクエストを作成しますか？

### コミット規約

プルリクエストを作成する前に、あなたのコミットがこのリポジトリで使用されているコミット規約に準拠しているかどうかを確認してください。

[Conventional Commits](https://www.conventionalcommits.org)に従い、コミットメッセージは英語で書いてください。

次の形式を使用します。

```text
<type>(<scope>): <description>
```

明確な変更領域がない場合、`scope`は任意です。

次のいずれかの タイプを使用してください。

- `feat`: 完全に新しいコードまたは新機能を導入する変更
- `fix`: バグを修正する変更
- `test`: テストに関する変更
- `docs`: ドキュメントの変更
- `refactor`: 修正でも機能追加でもないコード変更
- `chore`: 他のカテゴリに当てはまらないリポジトリ保守
- `ci`: 継続的インテグレーションに関する変更
- `build`: ビルドツール、依存関係、パッケージングに関する変更
- `perf`: パフォーマンスを改善する変更
- `style`: コードの挙動に影響しない変更

例:

```text
fix(config): reject duplicate reviewer accounts
feat(review): add unanimous approval policy
docs(prompts): explain output contracts
test(merge): cover majority decision handling
build: update release workflow
```

### プルリクエストの手順

1. [リポジトリ](https://github.com/magi-ai/opencode-magi)をフォークしてクローンします。

2. `main` ブランチから新しいブランチを作成します。形式は`<type>/<description>`とし、`type`には[Conventional Commits](https://www.conventionalcommits.org)のタイプのいずれかを、`description`にはケバブケースの短い要約を使います。

```text
fix/config-validation
feat/unanimous-approval
docs/review-flow
test/output-parser
```

3. プルリクエストは1つの変更に集中させてください。無関係な修正、リファクタリング、クリーンアップをまとめないでください。

4. 変更を加え、挙動変更にはテストを追加または更新します。関連するテストをローカルで`pnpm test`を実行してください。

5. 公開されているパッケージの挙動、公開設定、コマンド、リリースノートに影響する変更には`pnpm changeset`を実行して、changesetのファイルを追加してください。ドキュメントのみの変更ではchangesetのファイルは不要です。

6. [コミット規約](#コミット規約)に従って変更をコミットします。

7. ブランチをプッシュし、[テンプレート](.github/pull_request_template.md)に従ってプルリクエストを作成します。

## ライセンス

OpenCode Magi の GitHub リポジトリにコードを貢献することで、あなたの貢献コードが MIT ライセンスの下でライセンスされることに同意したものとみなされます。

### 最後まで読んでくれてありがとうございます。私もあなたを愛しています。💖
