---
name: nextjs-dify-chat
description: Next.js App Router アプリケーションに Dify チャットフロー API を統合するスキル。dify-client npm パッケージを使い、ストリーミングレスポンスを NDJSON 形式で Route Handler からクライアントに流す。クライアント側の TextDecoder バッファリングループ、AbortController による停止、conversationId 管理パターンも含む。「Dify」「dify-client」「チャットフロー」「streaming chat」「NDJSON」「チャット API」などのキーワードで使用すること。
---

# Next.js × Dify チャット統合

`dify-client` npm パッケージを使って Dify チャットフローを Next.js App Router から呼び出し、NDJSON ストリームでクライアントに流す実装パターン。

## セットアップ

```bash
npm install dify-client
```

`.env.local`:
```
DIFY_APP_API_KEY=your-api-key
DIFY_BASE_URL=https://api.dify.ai/v1   # 省略可、デフォルト値
```

---

## 実装ステップ

### Step 1: Dify クライアントシングルトン

`lib/dify/chat-client.ts`

```typescript
import { ChatClient } from "dify-client";

let chatClient: ChatClient | null = null;

function getDifyApiKey() {
  const apiKey = process.env.DIFY_APP_API_KEY ?? process.env.DIFY_API_KEY;
  if (!apiKey) {
    throw new Error("Missing DIFY_APP_API_KEY.");
  }
  return apiKey;
}

export function getDifyChatClient() {
  if (!chatClient) {
    chatClient = new ChatClient({
      apiKey: getDifyApiKey(),
      baseUrl: process.env.DIFY_BASE_URL,
    });
  }
  return chatClient;
}
```

### Step 2: 内部型定義

`lib/chat-types.ts`

```typescript
export type ChatStreamEventChunk = {
  type: "event";
  event: string | null;
  conversationId?: string;
  messageId?: string;
  taskId?: string;
  answerDelta?: string;
  createdAt?: number;
  // agent_log イベント用（不要なら省略可）
  toolName?: string;
  toolObservation?: string;
};

export type ChatStreamDoneChunk  = { type: "done" };
export type ChatStreamErrorChunk = { type: "error"; message: string };

export type ChatStreamChunk =
  | ChatStreamEventChunk
  | ChatStreamDoneChunk
  | ChatStreamErrorChunk;

export type ChatRequestBody = {
  query: string;
  conversationId?: string | null;
  sessionUserId: string;
};

export type ChatStopRequestBody = {
  taskId: string;
  sessionUserId: string;
};
```

### Step 3: Dify イベント → 内部型 の正規化

`lib/dify/normalizers.ts`（最小実装）

```typescript
import type { ChatStreamChunk } from "@/lib/chat-types";
import type { StreamEvent } from "dify-client";

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim();
  return v.length > 0 ? v : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

export function normalizeChatStreamEvent(
  streamEvent: StreamEvent<Record<string, unknown>>,
): ChatStreamChunk {
  const payload = asObject(streamEvent.data);
  if (!payload) {
    return { type: "event", event: streamEvent.event ?? null };
  }

  return {
    type: "event",
    event: streamEvent.event ?? asString(payload.event) ?? null,
    conversationId: asString(payload.conversation_id),
    messageId: asString(payload.message_id) ?? asString(payload.id),
    taskId: asString(payload.task_id),
    answerDelta: asString(payload.answer),
    createdAt: asNumber(payload.created_at),
  };
}
```

> agent_log（ツール呼び出し結果）のパースが必要な場合は [reference.md](reference.md) を参照。

### Step 4: Route Handler

`app/api/chat/route.ts`

```typescript
import type { ChatRequestBody, ChatStreamChunk } from "@/lib/chat-types";
import { getDifyChatClient } from "@/lib/dify/chat-client";
import { normalizeChatStreamEvent } from "@/lib/dify/normalizers";
import type { DifyStream } from "dify-client";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isDifyStream(
  value: unknown,
): value is DifyStream<Record<string, unknown>> {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof (value as { toText?: unknown }).toText === "function"
  );
}

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unexpected chat error.";
}

/** Dify ストリーム → ChatStreamChunk の AsyncGenerator */
async function* streamChunksFromDify(
  stream: DifyStream<Record<string, unknown>>,
): AsyncIterable<ChatStreamChunk> {
  try {
    for await (const event of stream) {
      yield normalizeChatStreamEvent(event);
    }
  } finally {
    yield { type: "done" };
  }
}

/** AsyncIterable<ChatStreamChunk> を NDJSON の ReadableStream に変換して返す */
function createNdjsonResponse(chunks: AsyncIterable<ChatStreamChunk>) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const chunk of chunks) {
          controller.enqueue(encoder.encode(`${JSON.stringify(chunk)}\n`));
        }
      } catch (error) {
        controller.enqueue(
          encoder.encode(
            `${JSON.stringify({
              type: "error",
              message: toErrorMessage(error),
            } satisfies ChatStreamChunk)}\n`,
          ),
        );
      } finally {
        controller.close();
      }
    },
  });

  return new NextResponse(stream, {
    headers: {
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "Connection": "keep-alive",
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "X-Accel-Buffering": "no",   // nginx のバッファリング無効化（Cloud Run 等で必要）
    },
  });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as ChatRequestBody | null;
  const query = typeof body?.query === "string" ? body.query.trim() : "";
  const conversationId =
    typeof body?.conversationId === "string" && body.conversationId.length > 0
      ? body.conversationId
      : undefined;
  const sessionUserId =
    typeof body?.sessionUserId === "string" && body.sessionUserId.length > 0
      ? body.sessionUserId
      : undefined;

  if (!query) {
    return NextResponse.json({ message: "A non-empty query is required." }, { status: 400 });
  }
  if (!sessionUserId) {
    return NextResponse.json({ message: "sessionUserId is required." }, { status: 400 });
  }

  try {
    const chatClient = getDifyChatClient();
    const result = await chatClient.createChatMessage({
      inputs: {},
      query,
      user: sessionUserId,
      conversation_id: conversationId,
      response_mode: "streaming",
      auto_generate_name: true,
    });

    const chunks = isDifyStream(result)
      ? streamChunksFromDify(result)
      : (async function* () {
          yield { type: "done" as const };
        })();

    return createNdjsonResponse(chunks);
  } catch (error) {
    return NextResponse.json({ message: toErrorMessage(error) }, { status: 500 });
  }
}
```

### Step 5: クライアント側のストリーム受信

React コンポーネント内で `fetch` + `ReadableStream` を使って NDJSON を受信する。

```typescript
// 状態
const [status, setStatus] = useState<"ready" | "submitted" | "streaming" | "error">("ready");
const abortControllerRef = useRef<AbortController | null>(null);
const activeTaskIdRef = useRef<string | null>(null);

const submitMessage = async (query: string, conversationId?: string, sessionUserId: string) => {
  const controller = new AbortController();
  abortControllerRef.current = controller;
  setStatus("submitted");

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, conversationId, sessionUserId }),
      signal: controller.signal,
    });

    if (!response.ok || !response.body) {
      throw new Error(response.status >= 500
        ? "サーバーエラーが発生しました。"
        : "送信に失敗しました。");
    }

    setStatus("streaming");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let resolvedConversationId: string | undefined;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        const chunk = JSON.parse(line) as ChatStreamChunk;

        if (chunk.type === "error") throw new Error(chunk.message);
        if (chunk.type === "done") continue;

        // taskId を保存（停止ボタン用）
        if (chunk.taskId) activeTaskIdRef.current = chunk.taskId;

        // 新規会話の conversationId を取得
        if (chunk.conversationId && !resolvedConversationId) {
          resolvedConversationId = chunk.conversationId;
          // ここで会話一覧を更新するなどのコールバックを呼ぶ
        }

        // テキストデルタを追記
        if (chunk.answerDelta) {
          // setAssistantContent(prev => prev + chunk.answerDelta)
        }
      }
    }
    // 残バッファ処理
    if (buffer.trim()) {
      const chunk = JSON.parse(buffer) as ChatStreamChunk;
      // ... 同様に処理
    }

    setStatus("ready");
  } catch (error) {
    if (controller.signal.aborted) {
      setStatus("ready");
      return;
    }
    setStatus("error");
  } finally {
    abortControllerRef.current = null;
    activeTaskIdRef.current = null;
  }
};

// 停止ボタン
const stopStreaming = async () => {
  const taskId = activeTaskIdRef.current;
  abortControllerRef.current?.abort();
  abortControllerRef.current = null;
  activeTaskIdRef.current = null;

  if (taskId && sessionUserId) {
    // サーバー側でも停止（Dify の stop API を呼ぶ Route Handler が必要）
    await fetch("/api/chat/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskId, sessionUserId }),
    }).catch(() => {});
  }
};
```

---

## オプション: ストリーム完了後に PubSub へ publish

`withPubSubPublish()` ジェネレーターで、ストリームを透過しながら完了後に publish する。詳細は [reference.md](reference.md) を参照。

```typescript
async function* withPubSubPublish(
  chunks: AsyncIterable<ChatStreamChunk>,
  query: string,
  initialConversationId: string | undefined,
): AsyncIterable<ChatStreamChunk> {
  let conversationId = initialConversationId;
  let fullAnswer = "";
  let completed = false;

  for await (const chunk of chunks) {
    if (chunk.type === "event") {
      if (chunk.conversationId) conversationId = chunk.conversationId;
      if (chunk.answerDelta) fullAnswer += chunk.answerDelta;
    }
    if (chunk.type === "done") completed = true;
    yield chunk;
  }

  if (completed && fullAnswer) {
    publishConversationHistory([
      { conversation_id: conversationId ?? null, role: "user", message: query, timestamp: new Date().toISOString() },
      { conversation_id: conversationId ?? null, role: "assistant", message: fullAnswer, timestamp: new Date().toISOString() },
    ]).catch(console.error);  // fire-and-forget
  }
}
```

Route Handler では `createNdjsonResponse(withPubSubPublish(rawChunks, query, conversationId))` のように差し込む。

---

## 詳細リファレンス

- Dify ストリームイベント一覧・agent_log パース・エラーハンドリング層の詳細 → [reference.md](reference.md)
