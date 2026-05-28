---
name: dify-hitl-workflow-api
description: Dify (v1.14.x) の Human Input Node (HITL / Human-in-the-Loop) を Service API (`/v1` namespace, Bearer `app-xxx` 認証) から外部システム・Web アプリで操作するためのスキル。ワークフロー起動 → paused 検知 → フォーム取得 → action (approve/reject 等) 送信 → 再開後の出力取得 (SSE ストリーミング / ポーリング) までの一連のフローを TypeScript/Node.js で実装する。`/v1/form/human_input/{form_token}`、`/v1/workflow/{task_id}/events`、`/v1/workflows/run`、`user` フィールドの一貫性、`include_state_snapshot` / `continue_on_pause` クエリパラメータを扱う。Dify の Human Input Node、HITL、承認フロー、approve/reject をAPI経由で実装する、ワークフローの一時停止/再開をAPIで制御する、といった依頼が来た場合に使用すること。
---

# Dify HITL (Human Input Node) Service API

Dify v1.14.x の Human Input Node を **Service API** (`/v1` namespace) から操作するためのスキルです。
外部の Web アプリやバックエンドから、ワークフローの一時停止 (pause) → 人間による承認 (approve/reject 等) → 再開 (resume) → 出力取得までを実装できます。

> **対象バージョン**: Dify **v1.14.x** (HITL Service API は PR #32826 で追加、2026-04-24 マージ)。
> v1.13.x では HITL は Console / Web App のみで、Service API 版は存在しません。

## 重要な前提（バージョンによる差異）

HITL の Service API は v1.14 で新規追加されたため、**ネット上の古い情報・誤情報が非常に多い**です。以下の事実は v1.14.2 のソースコードで直接検証済みです。**実装時はこのスキルの記述を正としてください。**

- 公式の API ドキュメントは**まだ未公開**です。正は「ソースコードと PR #32826」になります。
- 後述の「採用してはいけないエンドポイント」に挙げた API は**コードベースに存在しません**。

## API コンテキストの区別（最重要）

Dify には認証方式の異なる3つの API コンテキストがあります。HITL を外部連携する場合は必ず **Service API** を使います。

| API | URL prefix | 認証 | 用途 |
| --- | --- | --- | --- |
| **Service API** | `/v1` | `Authorization: Bearer app-xxx` | **外部連携はこれを使う** |
| Web API | `/api` | JWT + `X-App-Code` ヘッダ | 公開 Web App 用 (Passport 経由) |
| Console API | `/console/api` | ログインセッション | Dify コンソール内のみ |

よくある失敗: SSE ストリーミングで `/api/workflow/{task_id}/events` (Web API) を Bearer キーで叩いて
`401 {"code":"unauthorized","message":"App token is missing."}` になるケース。
Service API 版の `/v1/workflow/{task_id}/events` を使えば Bearer キーで動作します。

## エンドポイント一覧（v1.14.x Service API）

すべて `Authorization: Bearer app-xxx` が必須です（`@validate_app_token` で保護）。

| 用途 | メソッド・パス | `user` の渡し方 |
| --- | --- | --- |
| ワークフロー起動 | `POST /v1/workflows/run` | body (JSON) 必須 |
| 実行状態のポーリング | `GET /v1/workflows/run/{workflow_run_id}` | 不要 |
| 一時停止フォームの取得 | `GET /v1/form/human_input/{form_token}` | 不要 |
| action の送信 (resume) | `POST /v1/form/human_input/{form_token}` | body (JSON) 必須 |
| 再開後の SSE ストリーム | `GET /v1/workflow/{task_id}/events?user=...` | query 必須 |
| 実行停止 | `POST /v1/workflows/tasks/{task_id}/stop` | body (JSON) 必須 |

> `task_id` はパス名は `task_id` だが、実体は **`workflow_run_id`** を渡す（内部で `run_id=task_id` として解決される）。

## `user` フィールドの一貫性（実装上の最重要注意点）

ワークフロー起動・フォーム送信・events 取得で渡す `user` は**すべて同一の値**にすること。
すべて同じ `EndUser` レコードに解決される必要があり、events ハンドラには以下のチェックがある:

```python
if (
    workflow_run.created_by_role != CreatedByRole.END_USER
    or workflow_run.created_by != end_user.id
):
    raise NotFound("Workflow run not found")
```

`user` がずれていると、正しい `workflow_run_id` を渡していても `404 Workflow run not found` になる。

## フォーム送信 (action) のペイロード

`POST /v1/form/human_input/{form_token}` の body は3フィールドすべて必須:

```json
{
  "inputs": { "review_comment": "Looks good" },
  "action": "Approve",
  "user": "end-user-id-123"
}
```

- `inputs`: Human Input Node で定義したフォームフィールドの値（無い場合は `{}`）。
- `action`: ノードに設定した `user_actions` の action ID（例 `"Approve"` / `"Reject"`）。
- `user`: 起動時と同じ end-user 識別子（デコレータがハンドラ実行前に `EndUser` を解決/作成する）。

送信が成功するとワークフローはバックグラウンドで自動的に再開する（別途 resume API は不要）。
レスポンスは acknowledgment のみで、後続ノードの出力は含まれない → 出力取得は別途行う（後述）。

### エラーコード

| コード | 意味 |
| --- | --- |
| `400` | 不正な action ID / 必須 input 欠落 |
| `401` | 無効な API トークン |
| `404` | 無効な form token |
| `412` | フォーム送信済み or 期限切れ |

## paused 状態の検知

ワークフロー起動 (`POST /v1/workflows/run`) を `response_mode: "streaming"` で行うと、
Human Input Node に到達した時点で以下のイベントが流れる:

- `human_input_required` イベント: `form_id` / `node_id` / `inputs` / `actions` / `expiration_time` 等を含む。
- `workflow_paused` イベント: `data.status: "paused"`、`paused_nodes`、`reasons` を含む。

`response_mode: "blocking"` の場合も、レスポンスの `status` が `"paused"` になる。
ポーリングで検知する場合は `GET /v1/workflows/run/{workflow_run_id}` の `status` を見る。

> 正しいステータス文字列は **`paused`**。`waiting_for_input` ではない（これは誤情報）。

## 再開後の出力取得：2つの方法

### 方法1: SSE ストリーミング（リアルタイム重視・推奨）

```
GET /v1/workflow/{task_id}/events?user={end_user_id}
Authorization: Bearer app-xxx
```

クエリパラメータ:

- `include_state_snapshot=true` — 接続前に実行済みだったノードのイベントを永続化スナップショットから再生する。**resume 後に途中から接続するケースで推奨。**
- `continue_on_pause=true` — `workflow_paused` を受け取っても SSE 接続を開いたままにする。複数回の pause/resume をまたいで再接続不要。

バックエンド連携で「履歴の再生 + 一時停止をまたいで接続維持」の両方が欲しい場合は両方を有効化:
`?user=...&include_state_snapshot=true&continue_on_pause=true`

### 方法2: ポーリング（バックエンド連携でシンプルに）

```
GET /v1/workflows/run/{workflow_run_id}
Authorization: Bearer app-xxx
```

`status` フィールドを監視する:

- `running` / `paused` → 継続ポーリング（`paused` の間は `outputs` は `{}` で空）
- `succeeded` → `outputs` に最終出力が入る
- `failed` / `stopped` → 実行終了

1〜2秒間隔でのポーリングが目安。

### 使い分け

- インタラクティブな Web アプリ（即時フィードバックが欲しい）→ SSE ストリーミング
- 自動化・システム連携（実装をシンプルにしたい）→ ポーリング

## TypeScript/Node.js 実装

完全なクライアント実装（`DifyHitlClient` クラス、起動→検知→承認→出力取得の一連フロー、
SSE パース、ポーリング、エラーハンドリング）は [references/client.ts](references/client.ts) を参照。

設計のポイント:

- `user` をクライアントのコンストラクタで固定し、全リクエストで使い回して一貫性を保証する。
- SSE は `fetch` の `ReadableStream` を `TextDecoderStream` + 行バッファでパースする（`data: ` 行を JSON.parse）。
- `form_token` は `human_input_required` イベント、または `GET /v1/workflows/run/{id}` のレスポンスから取得する。
- 環境変数: `DIFY_BASE_URL`（例 `https://api.dify.ai` or セルフホストの URL）、`DIFY_API_KEY`（`app-xxx`）。

## 採用してはいけないエンドポイント（誤情報リスト）

以下は **v1.14.x のコードベースに存在しません**。古い回答やサードパーティ記事で見かけても使わないこと。

| 誤ったエンドポイント | 正しい代替 |
| --- | --- |
| `POST /v1/workflows/{workflow_id}/runs/{run_id}/events` | `POST /v1/form/human_input/{form_token}` |
| `POST /v1/workflows/{workflow_run_id}/resume` | `POST /v1/form/human_input/{form_token}` |
| `GET /apps/{app_id}/workflow-runs/{run_id}/pause-info` | `GET /v1/workflows/run/{workflow_run_id}` |
| `POST /api/form/human_input/{form_token}` (Bearer 不要) | `POST /v1/form/human_input/{form_token}` (Bearer 必須) |
| ステータス `waiting_for_input` / `waiting_node_id` | ステータスは `paused` |
| `/api/workflow/{task_id}/events` (Bearer で叩く) | `/v1/workflow/{task_id}/events` (Service API 版) |

## 参考リンク

- PR #32826 "feat: add service api of HITL" (2026-04-24 マージ) — HITL Service API の追加 PR。
- ソース: `api/controllers/service_api/app/human_input_form.py`, `workflow_events.py`, `workflow.py`
- Discussion #32389 — 本仕様の確認スレッド。
