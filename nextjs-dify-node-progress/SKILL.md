---
name: nextjs-dify-node-progress
description: Next.js × Dify チャットアプリで、ワークフロー実行中の各ノード名（Dify の data.title）をリアルタイムにユーザー側に表示するスキル。回答生成までの待ち時間に「⟳ 関連QAを検索しています...」のようなフィードバックを出し、ユーザー不安を解消する。node_started / node_finished イベントの正規化、ストリームチャンク型の拡張、回答デルタ受信時のクリア、start/end ノードのフィルタ、スケルトンからの差し替え UI を扱う。「Dify ワークフロー進行」「ノード名表示」「node_started」「node_finished」「実行中ノード」「Dify チャット ローディング表示」などのキーワードで使用すること。`nextjs-dify-chat` スキルで構築済みのチャット基盤に追加するパターン。
---

# Dify ワークフローノード進行状況の表示

Dify のチャットフローはストリーミング中に `node_started` / `node_finished` イベントを送ってくる。これらに含まれる `data.title`（ワークフロー作成者が日本語で命名したノード名）をリアルタイムにアシスタントメッセージ枠に表示することで、回答生成までの待ち時間中もユーザーに「裏で何が走っているか」が伝わる。

## 前提

`nextjs-dify-chat` スキルで構築した以下が存在していること：

- `lib/chat-types.ts` — `ChatStreamEventChunk`, `ChatMessage` 型
- `lib/dify/normalizers.ts` — `normalizeChatStreamEvent()`
- `app/api/chat/route.ts` — NDJSON ストリームを返す Route Handler
- クライアント側の NDJSON 受信ループ（`fetch` + `ReadableStream`）
- アシスタントメッセージのレンダリングコンポーネント（空コンテンツ時にスケルトン表示）

## 表示仕様（推奨デフォルト）

- **スタイル**: 現在実行中のノード 1 件のみをスピナー + テキストで表示
- **テキスト**: `⟳ {ノードのタイトル}`（例: `⟳ 関連QAを検索しています`）
- **消えるタイミング**: 最初の `answerDelta` 受信時。回答本文に置き換わる
- **対象ノード**: `node_type` が `start` / `end` のノードはスキップ（プラミング扱いで瞬時に消えるため）
- **既存のスケルトンへのフォールバック**: ノード情報がまだ届いていない瞬間はスケルトン表示

UX の選択肢として、進行履歴を ✓ 付きで積み上げる「タイムライン」型もあるが、まずはこのシンプル版で十分なケースが多い。

---

## 実装ステップ

### Step 1: ストリームチャンク型を拡張

`lib/chat-types.ts`

```typescript
export type ChatMessage = {
  // 既存...
  currentNodeTitle?: string;  // 追加: 実行中ノードのタイトル
};

export type ChatStreamEventChunk = {
  // 既存...
  nodeTitle?: string;   // 追加: node_started/node_finished の data.title
  nodeType?: string;    // 追加: data.node_type（"start"/"end" のフィルタ用）
};
```

### Step 2: normalizer を拡張

`lib/dify/normalizers.ts` に抽出ヘルパーと分岐を追加。

```typescript
function extractNodeFields(payload: Record<string, unknown>): {
  nodeTitle?: string;
  nodeType?: string;
} {
  const nodeData = asObject(payload.data);
  if (!nodeData) return {};

  return {
    nodeTitle: asString(nodeData.title),
    nodeType: asString(nodeData.node_type),
  };
}

export function normalizeChatStreamEvent(
  streamEvent: StreamEvent<Record<string, unknown>>,
): ChatStreamChunk {
  const payload = asObject(streamEvent.data);
  if (!payload) {
    return { type: "event", event: streamEvent.event ?? null };
  }

  const eventName = streamEvent.event ?? asString(payload.event) ?? null;

  const nodeFields =
    eventName === "node_started" || eventName === "node_finished"
      ? extractNodeFields(payload)
      : {};

  return {
    type: "event",
    event: eventName,
    conversationId: asString(payload.conversation_id),
    messageId: asString(payload.message_id) ?? asString(payload.id),
    taskId: asString(payload.task_id),
    answerDelta: asString(payload.answer),
    createdAt: asNumber(payload.created_at),
    ...nodeFields,
    // ...他の拡張フィールド（agentLogFields など）も同様に展開
  };
}
```

### Step 3: クライアント側のチャンク処理

NDJSON 受信ループの `processChunk` 内、conversationId 解決の後、`answerDelta` 処理の前に `node_started` ハンドラを追加。

```typescript
// node_started: 実行中ノード名を表示（start/end はスキップ）
if (
  chunk.event === "node_started" &&
  chunk.nodeTitle &&
  chunk.nodeType !== "start" &&
  chunk.nodeType !== "end"
) {
  const nodeTitle = chunk.nodeTitle;
  updateMessages(streamKey, (messages) =>
    messages.map((message) =>
      message.id === assistantMessage.id
        ? { ...message, currentNodeTitle: nodeTitle }
        : message,
    ),
  );
}
```

`answerDelta` 受信時に `currentNodeTitle` をクリアして、ノード表示を回答本文に置き換える。

```typescript
updateMessages(streamKey, (messages) =>
  messages.map((message) => {
    if (message.id !== assistantMessage.id) return message;
    return {
      ...message,
      content: `${message.content}${chunk.answerDelta ?? ""}`,
      createdAt: message.createdAt ?? chunk.createdAt,
      state: "streaming",
      currentNodeTitle: undefined,  // ← ここ
    };
  }),
);
```

`finalizeAssistantMessage`（`state: "done"` にする処理）でも `currentNodeTitle: undefined` を設定し、安全側に倒す。

> **node_finished は使わない**: 次の `node_started` で上書きされるので不要。最後のノード完了 → `message_end` までの一瞬は表示が残るが、`answerDelta` で即クリアされるので UX 上問題ない。

### Step 4: UI 表示

アシスタントメッセージのレンダリングで、空コンテンツ時の分岐に `currentNodeTitle` 表示を追加。既存のスケルトンはフォールバックとして残す。

```tsx
{message.content ? (
  /* 既存の Markdown レンダリング */
) : message.currentNodeTitle ? (
  <div className="flex items-center gap-2 pt-1 text-sm text-foreground-muted">
    <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-foreground-muted border-t-transparent" />
    <span>{message.currentNodeTitle}</span>
  </div>
) : (
  /* 既存スケルトン（パルスする 3 行のグレーバー等） */
)}
```

スピナーは Tailwind の `animate-spin` で十分。ロード状態と差別化したいなら色やサイズを調整する。

---

## node_started / node_finished のペイロード構造

```jsonc
// SSE の data フィールドに入ってくる構造
{
  "event": "node_started",
  "task_id": "5ad4cb98-...",
  "workflow_run_id": "5ad498-...",
  "data": {
    "id": "5ad498-...",                    // ノード実行 ID
    "node_id": "dfjasklfjdslag",           // ノード定義 ID
    "node_type": "llm",                    // start / end / llm / code / tool / knowledge-retrieval / ...
    "title": "関連QAを検索",                 // ← これを表示する
    "index": 2,                            // 実行順序（0始まり）
    "predecessor_node_id": "...",
    "inputs": { /* ... */ },
    "created_at": 1679586595
  }
}
```

`node_finished` は上記に加えて `outputs`, `status`, `elapsed_time`, `execution_metadata` を含む。

---

## ノードタイトルの命名規約

ノードタイトル（`data.title`）は Dify ワークフローエディタで作成者が自由に編集できる。**ユーザー向けの表示文として読める日本語**になっているか、Dify 側の運用者と合わせること。

例（推奨）:
- ❌ `LLM 1`, `Code 2`（デフォルト名のまま → ユーザーには意味不明）
- ✅ `関連QAを検索`, `回答を生成中`, `参考情報を整理`

---

## 検証ポイント

1. ネットワークタブで `/api/chat` の NDJSON を確認し、`node_started` チャンクに `nodeTitle` / `nodeType` が含まれていること
2. 回答開始までの間、ノード遷移に応じてタイトル表示が切り替わること
3. `start` / `end` ノードはスキップされ、表示が一瞬で消えないこと
4. 回答ストリーム開始の瞬間にノード表示が消え、Markdown 本文に置き換わること
5. 回答完了後（`state: "done"`）に再表示されないこと
6. ストップボタンで中断した場合もノード表示が残らないこと

---

## 関連スキル

- [nextjs-dify-chat](../nextjs-dify-chat/SKILL.md) — Dify チャット統合の基盤
