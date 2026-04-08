# shadcn/ui ↔ Pencil デザイン対応（参考）

エージェントは **実際の ref ID は常に `batch_get` で取得**すること。このファイルは「何を探すか」のマッピング用。

| shadcn コンポーネント | Pencil での探し方・使い方 |
|----------------------|---------------------------|
| Button | 名前に `Button` / `btn` など。variants は別コンポーネントまたはプロパティで表現されていることが多い |
| Card, CardHeader, CardContent, CardFooter | `Card` 系の再利用フレーム。スロットがあれば `instance/slotId` に子を入れる |
| Input, Textarea, Select トリガー | `Input` / `Field` / `Form` 系を検索 |
| Label | `Label` またはフォーム行コンポーネント内のテキストスロット |
| Badge | `Badge` / `Tag` |
| Tabs | `Tabs` / `Segmented` |
| Dialog / AlertDialog | モーダル枠・オーバーレイ付きフレーム |
| Sheet | サイドパネル型フレーム |
| Table | `get_guidelines(topic: "table")` と併用 |
| Separator | 1px の line / rectangle コンポーネント |
| Skeleton | プレースホルダ矩形のコンポーネント |
| Avatar | 円形画像フレーム + テキスト省略 |

## 画面パターン（クイック）

- **フォーム画面**: 垂直レイアウト + gap 16〜24、各フィールドは Label + Input のコンポーネント行
- **ダッシュボード**: グリッドまたは horizontal + vertical、指標は Card の ref を複数
- **設定**: 左ナビ（narrow）+ 右コンテンツ（fill）の 2 カラム
