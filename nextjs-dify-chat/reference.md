# Dify チャット統合 詳細リファレンス

## Dify ストリームイベント一覧

`dify-client` の `DifyStream` から流れてくる `StreamEvent.event` の値。

| イベント名 | タイミング | 主なフィールド |
|---|---|---|
| `message` | テキストデルタが届くたび | `answer`（差分テキスト）, `conversation_id`, `message_id`, `task_id` |
| `message_end` | ストリーム終了時 | `conversation_id`, `message_id`, `metadata` |
| `agent_message` | Agent モードのテキストデルタ | `answer`, `conversation_id`, `message_id`, `task_id` |
| `agent_thought` | Agent の思考ログ | `thought`, `tool`, `tool_input`, `observation` |
| `agent_log` | Agent のツール呼び出し結果 | `data.data.output.tool_call_name`, `data.data.output.tool_response` |
| `message_replace` | メッセージ全体の置き換え | `answer`（全文） |
| `error` | エラー発生時 | `code`, `message` |
| `ping` | キープアライブ | なし |

> `message_end` を受け取ったあとも `DifyStream` のイテレータは自然に終了するため、`finally` ブロックで `yield { type: "done" }` を送信するパターンで確実に終端を通知できる。

---

## StreamEvent → ChatStreamChunk マッピング

```
DifyStream<Record<string, unknown>>
  └── StreamEvent {
        event: string | undefined
        data: Record<string, unknown> | string | undefined
      }
```

| Dify フィールド | 内部型フィールド | 備考 |
|---|---|---|
| `event` | `chunk.event` | `streamEvent.event` を優先、なければ `data.event` |
| `data.conversation_id` | `chunk.conversationId` | 新規会話では最初のチャンクで届く |
| `data.message_id` / `data.id` | `chunk.messageId` | |
| `data.task_id` | `chunk.taskId` | 停止 API に必要 |
| `data.answer` | `chunk.answerDelta` | テキストの差分（空の場合は undefined） |
| `data.created_at` | `chunk.createdAt` | Unix timestamp（秒） |

### agent_log の追加フィールド

`agent_log` イベントのネスト構造：

```
streamEvent.data.data.output.tool_call_name   → chunk.toolName
streamEvent.data.data.output.tool_response    → chunk.toolObservation
streamEvent.data.data.status                  → "success" のときのみ有効
```

完全な `extractAgentLogFields` 実装例：

```typescript
function extractAgentLogFields(payload: Record<string, unknown>): {
  toolName?: string;
  toolObservation?: string;
} {
  const nodeData = asObject(payload.data);
  if (!nodeData || asString(nodeData.status) !== "success") return {};

  const output = asObject(asObject(nodeData.data)?.output);
  if (!output) return {};

  return {
    toolName: asString(output.tool_call_name),
    toolObservation: asString(output.tool_response),
  };
}
```

---

## 完全な型定義

アプリ固有の型を含む完全版（`lib/chat-types.ts` 向け）：

```typescript
export const DRAFT_CONVERSATION_ID = "__draft__";

export type ChatStatus = "ready" | "submitted" | "streaming" | "error";

export type QAResult = {
  id: string;
  question: string;
  answer: string;
};

export type ToolObservation = {
  toolName: string;
  observation: string;
  results?: QAResult[];
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt?: number;
  state?: "streaming" | "done";
  toolObservations?: ToolObservation[];
};

export type ConversationSummary = {
  id: string;
  name: string;
  status: string;
  introduction?: string;
  createdAt?: number;
  updatedAt?: number;
};

export type ChatRequestBody = {
  query: string;
  conversationId?: string | null;
  sessionUserId: string;
};

export type ChatStopRequestBody = {
  taskId: string;
  sessionUserId: string;
};

export type ChatStreamEventChunk = {
  type: "event";
  event: string | null;
  conversationId?: string;
  messageId?: string;
  taskId?: string;
  answerDelta?: string;
  createdAt?: number;
  toolName?: string;
  toolObservation?: string;
  toolResults?: QAResult[];
};

export type ChatStreamDoneChunk  = { type: "done" };
export type ChatStreamErrorChunk = { type: "error"; message: string };

export type ChatStreamChunk =
  | ChatStreamEventChunk
  | ChatStreamDoneChunk
  | ChatStreamErrorChunk;
```

---

## エラーハンドリング層

| 層 | 発生場所 | ハンドリング方法 | ユーザーへの影響 |
|---|---|---|---|
| **バリデーションエラー** | Route Handler（POST 入口） | `400 JSON` を返す | fetch 側で `response.ok === false` として検出 |
| **Dify 接続エラー** | `chatClient.createChatMessage()` | `try/catch` → `500 JSON` | fetch 側で `response.status >= 500` 判定 |
| **ストリーム中エラー** | `ReadableStream.start()` の `catch` | `type: "error"` チャンクをストリームに流す | クライアント側で `chunk.type === "error"` を throw に変換 |
| **クライアント: abort** | `controller.abort()` 後の `reader.read()` | `controller.signal.aborted` で判定してエラー表示をスキップ | ユーザーに何も表示しない（正常停止） |
| **クライアント: ネットワークエラー** | `fetch()` 自体が reject | `error instanceof TypeError` で検出 | "ネットワークエラー" メッセージを表示 |
| **PubSub エラー** | `publishConversationHistory().catch()` | fire-and-forget、ログのみ | UI に影響しない |

### クライアント側エラー分岐パターン

```typescript
catch (error) {
  if (controller.signal.aborted) {
    setStatus("ready");   // abort は正常停止 → エラー表示しない
    return;
  }
  if (error instanceof TypeError) {
    setErrorMessage("ネットワークエラーが発生しました。");
  } else if (error instanceof Error) {
    setErrorMessage(error.message);
  } else {
    setErrorMessage("予期せぬエラーが発生しました。");
  }
  setStatus("error");
}
```

---

## 停止 API（`/api/chat/stop`）

Dify にストリームを中断させる Route Handler。

```typescript
// app/api/chat/stop/route.ts
import type { ChatStopRequestBody } from "@/lib/chat-types";
import { getDifyChatClient } from "@/lib/dify/chat-client";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as ChatStopRequestBody | null;
  const taskId = body?.taskId;
  const sessionUserId = body?.sessionUserId;

  if (!taskId || !sessionUserId) {
    return NextResponse.json({ message: "taskId and sessionUserId are required." }, { status: 400 });
  }

  try {
    const chatClient = getDifyChatClient();
    await chatClient.stopMessage(taskId, sessionUserId);
    return NextResponse.json({ success: true });
  } catch {
    // Dify 側の停止が失敗しても UI はすでに abort 済みのためエラーを無視
    return NextResponse.json({ success: false });
  }
}
```

---

## PubSub publish の完全実装

`lib/pubsub.ts`（`@google-cloud/pubsub` が必要）：

```bash
npm install @google-cloud/pubsub
```

```typescript
import { PubSub } from "@google-cloud/pubsub";

type ConversationHistoryMessage = {
  conversation_id: string | null;
  role: "user" | "assistant";
  message: string;
  timestamp: string; // ISO 8601
};

let pubSubClient: PubSub | null = null;

function getPubSubClient() {
  if (!pubSubClient) {
    pubSubClient = new PubSub({ projectId: process.env.GOOGLE_CLOUD_PROJECT });
  }
  return pubSubClient;
}

export async function publishConversationHistory(
  messages: ConversationHistoryMessage[],
): Promise<void> {
  const topicName = process.env.PUBSUB_CONVERSATION_TOPIC;
  if (!topicName) {
    throw new Error("Missing PUBSUB_CONVERSATION_TOPIC");
  }

  const topic = getPubSubClient().topic(topicName);

  await Promise.all(
    messages.map((msg) =>
      topic.publishMessage({ data: Buffer.from(JSON.stringify(msg)) }),
    ),
  );
}
```

環境変数追加：

```
GOOGLE_CLOUD_PROJECT=your-gcp-project-id
PUBSUB_CONVERSATION_TOPIC=your-topic-name
```

> `PUBSUB_CONVERSATION_TOPIC` が未設定時は `throw` される → Route Handler 側で `.catch()` してログのみ出力すれば UI に影響しない。

---

## ブロッキングレスポンスへのフォールバック

`dify-client` が `DifyStream` を返さず通常オブジェクトを返した場合（設定によって発生し得る）のフォールバック：

```typescript
function normalizeBlockingChatResponse(data: unknown): ChatStreamChunk[] {
  const payload = data && typeof data === "object" && !Array.isArray(data)
    ? data as Record<string, unknown>
    : undefined;

  if (!payload) return [{ type: "done" }];

  const answer = typeof payload.answer === "string" ? payload.answer.trim() : undefined;
  const conversationId = typeof payload.conversation_id === "string"
    ? payload.conversation_id.trim() || undefined
    : undefined;

  return [
    { type: "event", event: "message", conversationId, answerDelta: answer || undefined },
    { type: "done" },
  ];
}
```
