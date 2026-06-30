<p align='center'>
  <a href='close-reconsideration.md'>English</a> | 日本語
</p>

# クローズ再考

[`close-reconsideration`](/src/prompts/review/close-reconsideration/task.md)は、少数派になったクローズと判定をしたレビュアーエージェントに再考させるプロンプトです。

このプロンプトでは、却下されたクローズの判定を承認または変更リクエストに判定を変更させます。

## 実行タイミング

`review.merge.approvalPolicy`が`unanimous`の場合に、1人以上のレビュアーがクローズと判定したものの、クローズが多数決に届かなかった場合に実行します。

## カスタマイズ

このプロンプトをカスタマイズするには、`review.prompts.closeReconsideration`にプロンプトファイルのパスを指定します。

## プレースホルダー

| プレースホルダー | 説明                     |
| ---------------- | ------------------------ |
| `{pr}`           | プルリクエスト番号。     |
| `{owner}`        | リポジトリのオーナー名。 |
| `{repo}`         | リポジトリ名。           |
