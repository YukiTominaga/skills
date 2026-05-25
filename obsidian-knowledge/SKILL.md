---
name: obsidian-knowledge
description: Claude が自身のタスク実行を通じて得た知見を Obsidian Vault の `/Claude/` 配下に蓄積し、以降のタスク開始時に Vault から関連知識を検索して活用するスキル。ユーザーから新規タスクを受けた直後に必ず `obsidian_simple_search` で関連ノートを探し、タスク完了後には再利用可能な技術的知見・ユーザーの好み・プロジェクト固有のコンテキストを Vault に書き戻す。`mcp__mcp-obsidian__*` ツールが接続された状態で、コーディング・設計判断・トラブルシューティング・プロジェクト固有の依頼・調査タスクを受けたら必ずこのスキルを発動すること。ユーザーが「ナレッジ化して」「思い出して」「過去のメモを参照して」と明示しなくても、技術的な作業や継続性のあるプロジェクト作業であれば自律的にこのスキルを使う。一回限りの雑談・単純な事実質問・極めて短い応答だけで完結する依頼には使わない。
---

# Obsidian Knowledge Skill

このスキルは Claude を「ステートレスな実行体」から「Vault を長期記憶として持つ協働者」へ拡張するためのものです。Obsidian の `/Claude/` 配下を Claude 専用エリアとして使い、過去の作業から得た知見を将来の自分（または同じ Vault を使う別セッション）に渡します。

## 設計思想

ユーザーが繰り返し同じ前提を説明しなくても済むようにすることが最大の目的です。Vault は Claude の「外部記憶」であり、毎回ゼロから推測するより、過去の判断と教訓を参照して作業した方が品質も速度も上がります。一方で、Vault を「会話ログの墓場」にしないために、書き込むのは**再利用可能な知見だけ**に絞ります。

## 前提

- Obsidian MCP (`mcp__mcp-obsidian__*`) が接続されている
- 書き込み先のルートは Vault 内の `/Claude/` 配下（既存ノートを汚染しない）

## Vault 構造

Claude が触る範囲は `/Claude/` のみ。それ以外のノートは**読むことはあっても書かない**こと。

```
/Claude/
├── Index.md                       # 主要ノートへのリンク集（任意でメンテ）
├── Knowledge/                     # 再利用可能な技術的知見
│   ├── Patterns/                  # 設計・コーディングパターン
│   ├── Troubleshooting/           # ハマったエラーと解決策
│   └── Decisions/                 # アーキテクチャ判断の根拠
├── Preferences/
│   └── user-preferences.md        # 命名規則・好みのライブラリ・避けたいパターン
└── Projects/
    └── <project-slug>/
        ├── context.md             # 案件の前提・制約・関係者
        ├── decisions.md           # その案件での意思決定ログ
        └── todos.md               # 持ち越しタスク
```

`<project-slug>` は kebab-case でユーザーが案件名として使っている呼称に合わせる。判断できない場合は本人に確認する。

## frontmatter 規約

すべての Claude 生成ノートに以下の frontmatter を必ず付ける。検索性とメンテ性のため。

```yaml
---
title: GCP Observability での ADC トークン更新パターン
created: 2026-05-25
updated: 2026-05-25
tags: [gcp, opentelemetry, hono]
project: global              # プロジェクト横断なら "global"、案件固有なら slug
source: claude-session
confidence: high             # high / med / low - 一度しか確認していない knowledge は low
---
```

`confidence` は後から自分や別セッションが「これは検証済みか、推測か」を判断するための重要な情報。動作確認できていない、ユーザー合意が取れていない、再現性が不明、のいずれかなら必ず `low` を入れる。

## 読み込みプロトコル（タスク開始時）

ユーザーから新しい依頼を受けたら、コードに手を付ける前に Vault を覗く。これを飛ばさないこと——ユーザーが過去に伝えた前提や好みを無視して作業すると、何度も同じ修正を繰り返すことになる。

1. **キーワード抽出**: 依頼文から以下を抜き出す
   - プロジェクト名・案件 slug
   - 技術キーワード（フレームワーク、ライブラリ、サービス名）
   - ドメイン用語（業務固有の名詞）

2. **常に最初に確認するノート**:
   - `/Claude/Preferences/user-preferences.md` — `obsidian_get_file_contents` で取得
   - `/Claude/Projects/<slug>/` 配下 — プロジェクトが特定できる場合のみ

3. **キーワード検索**: 抽出したキーワードで `obsidian_simple_search` を実行。ヒット件数が多すぎる（10件超）場合は `obsidian_complex_search` で frontmatter の tag やパスで絞り込む。

4. **一括取得**: 関連性が高そうな上位 3-5 件を `obsidian_batch_get_file_contents` でまとめて読む。

5. **参照根拠の明示**: 過去ノートを使って判断した場合、ユーザーへの応答で「過去のメモ（`/Claude/Knowledge/Patterns/xxx.md`）によると〜」と出典を示す。これにより、ユーザーが古い情報を訂正できる。

タスクと無関係な検索結果しか出てこなかった場合は読み込みを切り上げて作業に進む。空振りは普通のこと。

## 書き込みプロトコル（タスク完了時）

タスクが完了したら、その作業から学んだことを Vault に残すか判断する。**残すべきか迷ったら残さない**——ノイズの多い Vault は使われなくなる。

### 書き込む価値があるかの判定

以下を**すべて満たす**ときだけ書く:

- **再利用可能**: 特定タスクの生コードでなく、原則・パターン・教訓・前提として抽象化されている。「Hono で OTLP exporter を書く時の認証パターン」は OK、「app/api/foo/route.ts の bug fix」は NG。
- **重複しない**: 書き込む前に `obsidian_simple_search` で同じトピックの既存ノートを確認する。既にあれば追記。
- **確度が高い**: 動作確認済み、ユーザー合意済み、または複数回再現したもの。「たぶんこうだと思う」は書かない（書くなら `confidence: low` で）。
- **秘匿情報を含まない**: API キー、トークン、PII、社外秘の固有名詞などが含まれていない。

### 書き込み方法

新規ノートを作る場合と既存ノートに追記する場合で使うツールが違う:

- **新規作成 / ファイル末尾への追記**: `obsidian_append_content`
  - ファイルが存在しない場合は作成される
  - frontmatter を含めた完全な内容を渡す
- **既存ノートの特定セクションへの挿入**: `obsidian_patch_content`
  - heading 配下や block reference に挿入する場合に使う
  - frontmatter を上書きしないよう注意

### カテゴリ別の振り分け

| 内容 | 配置 |
|------|------|
| 設計パターン・実装パターン | `/Claude/Knowledge/Patterns/<topic>.md` |
| 特定エラーと解決策 | `/Claude/Knowledge/Troubleshooting/<error-or-symptom>.md` |
| アーキテクチャ判断の理由 | `/Claude/Knowledge/Decisions/<decision-topic>.md` |
| ユーザーの好み・命名規則・嫌うパターン | `/Claude/Preferences/user-preferences.md` （追記） |
| プロジェクト固有のコンテキスト | `/Claude/Projects/<slug>/context.md` |
| プロジェクト内の意思決定ログ | `/Claude/Projects/<slug>/decisions.md` |
| 次セッションに渡したいタスク | `/Claude/Projects/<slug>/todos.md` |

### 書き込んだ後の報告

書き込みが完了したら、ユーザーへの応答末尾に簡潔に記録先を伝える。長々と内容を再掲しない。

```
- `/Claude/Knowledge/Patterns/otel-adc-token-refresh.md` を新規作成しました（再利用可能なため）
```

## 禁則事項

以下は絶対に書かない:

- **秘匿情報**: API キー、アクセストークン、サービスアカウント鍵、PII（メールアドレス・電話番号・住所など）、社外秘の固有名詞
- **推測**: 「たぶん」「おそらく」レベルの仮説。書くなら `confidence: low` を必ず付け、推測である旨を本文にも明記
- **一時的な発言**: ユーザーの愚痴、感情的反応、その場限りの言葉
- **5W1H が不明な断片**: あとで読んでも文脈が再現できないメモ
- **会話ログのコピペ**: 抽象化・要約せずに貼っただけのもの

## 例

### 例1: タスク開始時の読み込み

**依頼**: 「Hono で Cloud Trace を実装したい。OTLP で直接送信する方式で。」

**Claude の動き**:

1. キーワード抽出: `hono`, `cloud trace`, `OTLP`, `opentelemetry`
2. `/Claude/Preferences/user-preferences.md` を読む
3. `obsidian_simple_search` で `hono OTLP` を検索
4. ヒットした `/Claude/Knowledge/Patterns/hono-otlp-direct.md` を読む
5. 「過去のメモによると ADC トークンの自動更新が必須でした。同じ構成で進めます」と参照根拠を明示してから実装

### 例2: タスク完了時の書き込み

**作業内容**: GCP Identity Platform を Next.js App Router で実装。セッションクッキー検証で Edge runtime と Node.js runtime のどちらを使うべきか調査・合意した。

**判定**:
- 再利用可能 ✓ （他案件でも同じ判断が要る）
- 重複なし ✓ （事前検索で類似ノートなし）
- 確度高い ✓ （実装して動作確認済み、ユーザー合意済み）
- 秘匿情報なし ✓

→ `/Claude/Knowledge/Decisions/nextjs-auth-runtime-choice.md` に新規作成。frontmatter に `confidence: high`, `tags: [nextjs, identity-platform, auth]`, `project: global` を入れる。

### 例3: 書かない判断

**作業内容**: ユーザー依頼で `package.json` の lint script の typo を直しただけ。

**判定**: 再利用可能性なし（特定リポジトリの一過性の修正）→ **書かない**。

## 補足: Vault 全文検索のヒント

`obsidian_simple_search` はキーワードの単純マッチ。複数キーワードを AND で絞りたい場合や、frontmatter の tag・path で絞り込みたい場合は `obsidian_complex_search` を使う。Dataview クエリのような構文が使えるので、`tag: #gcp AND path: /Claude/Knowledge/` のような絞り込みが可能。

## 補足: Index.md の運用

`/Claude/Index.md` は任意。手動でメンテするのが面倒なら、月次で `obsidian_list_files_in_dir` を `/Claude/Knowledge/` に対して実行し、新規ノートを Index.md に追記する程度で十分。Claude が自律的に更新するのは「主要カテゴリに新しいサブカテゴリを作った時」のみに留める。
