---
name: nextjs-dify-workflow-api
description: Next.js App Router から Dify Workflow API (`POST /v1/workflows/run`) を **生 fetch** で呼び出し、ファイルアップロード → ワークフロー起動 → SSE (`response_mode: "streaming"`) のイベントを Route Handler 内でパースし、NDJSON でクライアントへ再ストリームする実装パターン。`dify-client` SDK を使わない・チャットフローではない・HITL Service API でもない、"純粋な Workflow を API として呼び出す" ケース全般を対象とする。`/v1/files/upload` での local_file アップロード、`workflow_started` / `node_started` / `node_finished` / `workflow_finished` イベントの処理、`outputs.structured_output.X` と `outputs.X` の両対応、Zod による安全な再エミット、`logger.withSpan` での OpenTelemetry 計装、`USE_DIFY=0` でのサンプルフォールバック、`difyUser()` による user 識別子の名前空間化を扱う。「Dify Workflow API」「workflows/run」「ワークフローを API として呼ぶ」「Dify ファイルアップロード」「SSE → NDJSON」「Dify 生 fetch」などのキーワードで使用すること。Chatflow を呼ぶなら `nextjs-dify-chat`、Human Input Node の承認フローを実装するなら `dify-hitl-workflow-api` を使う。
---

# Next.js × Dify Workflow API (生 fetch)

Dify の **Workflow** (Chatflow ではない) を Service API として呼び出し、Next.js App Router の Route Handler を介してブラウザに再ストリームするパターン。

## このスキルの守備範囲

| ケース | 使うスキル |
| --- | --- |
| **Workflow を API として実行する**（このスキル） | `nextjs-dify-workflow-api` |
| Chatflow / chat-messages API（会話 ID、会話履歴がある） | `nextjs-dify-chat` |
| Human Input Node (HITL) 経由の承認フロー | `dify-hitl-workflow-api` |
| ワークフロー実行中のノード名をユーザに表示する UI | `nextjs-dify-node-progress` |

Workflow API を呼ぶ理由：

- SDK (`dify-client`) は Chatflow 中心の抽象化で、Workflow には恩恵が薄い。
- SSE → NDJSON への変換を**自前で持ったほうが**、ノード進捗の中継、独自スキーマ検証、サンプルフォールバック等を素直に書ける。

## 環境変数

```bash
DIFY_BASE_URL=https://api.dify.ai/v1     # 末尾スラッシュは getter 側で除去
DIFY_API_KEY=app-xxxxxxxxxxxxxxxxxxxx    # Chatflow / 共通用（あれば）
DIFY_EXTRACT_WORKFLOW_API_KEY=app-yyyy   # Workflow ごとに API キーが分かれる場合
DIFY_USER_PREFIX=hitl                    # difyUser() の名前空間（任意、デフォルト "hitl"）
USE_DIFY=0                               # 1 以外/未設定で有効、"0" で無効化（サンプルにフォールバック）
```

> Workflow ごとに別 API キーが発行されるので、`getDifyConfig()` (Chatflow 用) と `getDifyWorkflowConfig()` (Workflow 用) のように getter を分けるのが定石。

## ⚠️ Workflow スキーマの罠（最重要）

Dify Studio で組んだ Workflow の **Start / End ブロックのスキーマが想定と違うと、API は無音で hang する**（エラーも `workflow_finished` も流れて来ず、SSE が永遠に閉じない）。実装前に必ず Dify 側で：

- **Start ブロック**の入力変数名が `inputs` に渡すキーと完全一致すること（例：`documents` という File List 変数）。
- **End ブロック**で `outputs` に載せたいキーが選ばれていること（例：`qa` または `structured_output.qa`）。
- File List 系の入力は `documents: [{ type, transfer_method: "local_file", upload_file_id }]` の形で渡す。

`workflow_finished.outputs` は **Dify バージョン / End ブロックの設定によって** トップレベルに出るか `structured_output` でラップされるかが揺れるので、両方を見るのが安全。

---

## 実装ステップ

### Step 1: 設定取得 + ユーザ名前空間

`lib/dify/config.ts`

```typescript
import 'server-only';

export type DifyConfig = {
  baseUrl: string;
  apiKey: string;
  userPrefix: string;
};

function baseConfig(apiKey: string | undefined): DifyConfig | null {
  const baseUrl = process.env.DIFY_BASE_URL?.replace(/\/+$/, '');
  if (!baseUrl || !apiKey || process.env.USE_DIFY === '0') return null;
  return {
    baseUrl,
    apiKey,
    userPrefix: process.env.DIFY_USER_PREFIX ?? 'app',
  };
}

/** Chatflow / chat-messages 用 */
export function getDifyConfig(): DifyConfig | null {
  return baseConfig(process.env.DIFY_API_KEY);
}

/** Workflow ごとに別 API キーを持つ場合の例（必要に応じて複製） */
export function getDifyWorkflowConfig(): DifyConfig | null {
  return baseConfig(process.env.DIFY_EXTRACT_WORKFLOW_API_KEY);
}

/** 全リクエストで同一 user を渡す必要があるため、生成は一元化 */
export function difyUser(cfg: DifyConfig, suffix?: string): string {
  return suffix ? `${cfg.userPrefix}:${suffix}` : cfg.userPrefix;
}
```

> `USE_DIFY=0` のときは null を返す → 呼び出し側でサンプルにフォールバックする運用を想定。

### Step 2: ファイルアップロード（必要なら）

Workflow が File / File List 入力を取る場合、まず `/v1/files/upload` にアップロードして `upload_file_id` を得る。

`lib/dify/files.ts`

```typescript
import 'server-only';
import type { DifyConfig } from './config';

export type DifyFileType = 'document' | 'image' | 'audio' | 'video' | 'custom';

const FILE_TYPE_BY_EXT: Record<string, DifyFileType> = {
  pdf: 'document',
  txt: 'document',
  eml: 'document',
  csv: 'document',
  json: 'document',
};

export function inferDifyFileType(filename: string, mime?: string): DifyFileType {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  if (FILE_TYPE_BY_EXT[ext]) return FILE_TYPE_BY_EXT[ext];
  if (mime?.startsWith('image/')) return 'image';
  return 'custom';
}

export type UploadedFile = { id: string; type: DifyFileType };

export async function uploadFileToDify(
  cfg: DifyConfig,
  file: File,
  user: string
): Promise<UploadedFile> {
  const fd = new FormData();
  fd.append('file', file);
  fd.append('user', user);
  const res = await fetch(`${cfg.baseUrl}/files/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
    body: fd,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Dify file upload failed: ${res.status} ${text}`);
  }
  const data = (await res.json()) as { id: string };
  return { id: data.id, type: inferDifyFileType(file.name, file.type) };
}
```

### Step 3: Workflow 実行 (streaming)

`lib/dify/workflow.ts`

```typescript
import 'server-only';
import type { DifyConfig } from './config';

export type DifyWorkflowRunRequest = {
  inputs: Record<string, unknown>;
  user: string;
  signal?: AbortSignal;
};

export async function runWorkflow(
  cfg: DifyConfig,
  req: DifyWorkflowRunRequest
): Promise<Response> {
  const res = await fetch(`${cfg.baseUrl}/workflows/run`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      inputs: req.inputs,
      response_mode: 'streaming' as const,
      user: req.user,
    }),
    signal: req.signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Dify workflow run failed: ${res.status} ${text}`);
  }
  return res;
}
```

### Step 4: SSE パーサ + NDJSON 出力ユーティリティ

Dify の SSE は `data: {json}\n\n` 形式。`\n\n` 区切りでバッファを切って各 event を JSON.parse する。

`lib/dify/stream.ts`

```typescript
import 'server-only';

const encoder = new TextEncoder();

/** 任意のシリアライズ可能オブジェクトを 1 行 NDJSON で出力 */
export function ndjsonLine(event: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(event) + '\n');
}

export function ndjsonHeaders(): HeadersInit {
  return {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no', // Cloud Run / nginx のバッファ無効化
  };
}

/** Dify SSE (`data: {...}\n\n`) を 1 イベントずつ yield */
export async function* parseDifySSE(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const lines = raw.split('\n');
      let dataLine = '';
      for (const line of lines) {
        if (line.startsWith('data:')) dataLine += line.slice(5).trimStart();
      }
      if (!dataLine || dataLine === '[DONE]') continue;
      try {
        yield JSON.parse(dataLine);
      } catch {
        // 壊れたチャンクは無視
      }
    }
  }
}
```

### Step 5: クライアントへ流すイベント型を Zod で固める

クライアントとの境界は **判別共用体 + Zod safeParse** にして、想定外形を再エミットしない。

`lib/dify/events.ts`

```typescript
import { z } from 'zod';

export const workflowStreamEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('meta'), runId: z.string().optional() }),
  z.object({
    type: z.literal('workflow.node'),
    phase: z.enum(['started', 'finished']),
    title: z.string(),
  }),
  z.object({
    type: z.literal('workflow.result'),
    outputs: z.unknown(), // 個別 schema は呼び出し元で再検証
  }),
  z.object({ type: z.literal('error'), message: z.string() }),
]);

export type WorkflowStreamEvent = z.infer<typeof workflowStreamEventSchema>;
```

### Step 6: Route Handler（中継本体）

`app/api/<feature>/route.ts`

```typescript
import { logger } from '@/lib/logging'; // OTel withSpan ラッパ（任意）
import { getDifyWorkflowConfig, difyUser } from '@/lib/dify/config';
import { uploadFileToDify } from '@/lib/dify/files';
import { runWorkflow } from '@/lib/dify/workflow';
import { ndjsonHeaders, ndjsonLine, parseDifySSE } from '@/lib/dify/stream';
import {
  workflowStreamEventSchema,
  type WorkflowStreamEvent,
} from '@/lib/dify/events';

export const runtime = 'nodejs';

function emit(
  controller: ReadableStreamDefaultController<Uint8Array>,
  event: WorkflowStreamEvent
) {
  const parsed = workflowStreamEventSchema.safeParse(event);
  if (!parsed.success) return; // 想定外形は流さない（型崩れの拡散防止）
  controller.enqueue(ndjsonLine(parsed.data));
}

export async function POST(req: Request) {
  const traceparent = req.headers.get('traceparent') ?? undefined;
  const xCloudTraceContext = req.headers.get('x-cloud-trace-context') ?? undefined;

  // --- 入力バリデーション（multipart の例）
  const form = await req.formData();
  const files = form.getAll('files').filter((v): v is File => v instanceof File);
  if (files.length === 0) {
    return Response.json({ error: 'files is required' }, { status: 400 });
  }

  const cfg = getDifyWorkflowConfig();

  // --- USE_DIFY=0 などでフォールバック（任意）
  if (!cfg) {
    return new Response(
      new ReadableStream<Uint8Array>({
        async start(controller) {
          emit(controller, { type: 'meta', runId: 'sample' });
          emit(controller, { type: 'workflow.result', outputs: { sample: true } });
          controller.close();
        },
      }),
      { headers: ndjsonHeaders() }
    );
  }

  return logger.withSpan('dify.workflow.run', async () => {
    const user = difyUser(cfg, crypto.randomUUID());
    const uploaded = await Promise.all(files.map((f) => uploadFileToDify(cfg, f, user)));

    // ⚠️ inputs のキー名は Dify Studio の Start ブロック変数名と完全一致させる
    const inputs = {
      documents: uploaded.map((u) => ({
        type: u.type,
        transfer_method: 'local_file' as const,
        upload_file_id: u.id,
      })),
    };

    const difyRes = await runWorkflow(cfg, { inputs, user, signal: req.signal });
    if (!difyRes.body) throw new Error('Dify workflow response has no body');

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let emittedResult = false;
        try {
          emit(controller, { type: 'meta' });

          for await (const evt of parseDifySSE(difyRes.body!)) {
            const event = (evt as { event?: string }).event;

            if (event === 'workflow_started') continue;

            if (event === 'node_started' || event === 'node_finished') {
              const data =
                (evt as { data?: { title?: string; node_type?: string } }).data ?? {};
              // start/end ノードは UX 上ノイズなので除外することが多い
              if (data.node_type === 'start' || data.node_type === 'end') continue;
              emit(controller, {
                type: 'workflow.node',
                phase: event === 'node_started' ? 'started' : 'finished',
                title: data.title ?? '',
              });
              continue;
            }

            if (event === 'workflow_finished') {
              const data =
                (evt as { data?: { status?: string; outputs?: unknown; error?: string } })
                  .data ?? {};
              if (data.status === 'failed') {
                emit(controller, { type: 'error', message: data.error ?? 'workflow failed' });
                return;
              }
              // ⚠️ outputs はトップレベル / structured_output どちらに来るか揺れる
              const outputs = (data.outputs ?? {}) as Record<string, unknown> & {
                structured_output?: Record<string, unknown>;
              };
              const merged = { ...outputs.structured_output, ...outputs };
              emit(controller, { type: 'workflow.result', outputs: merged });
              emittedResult = true;
              continue;
            }

            if (event === 'error') {
              emit(controller, {
                type: 'error',
                message: (evt as { message?: string }).message ?? 'Dify workflow error',
              });
              return;
            }
          }

          if (!emittedResult) {
            // workflow_finished が来ずに SSE が閉じた = Studio 側のスキーマ不一致を疑う
            emit(controller, {
              type: 'error',
              message: 'ストリームが途中で切断されました（Workflow の Start/End スキーマを確認）',
            });
          }
        } catch (err) {
          logger.logError('dify.workflow.run: stream failed', err, traceparent, xCloudTraceContext);
          emit(controller, {
            type: 'error',
            message: err instanceof Error ? err.message : '不明なエラー',
          });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, { headers: ndjsonHeaders() });
  });
}
```

### Step 7: クライアント側 NDJSON コンシューマ

`lib/dify/stream-client.ts`

```typescript
import { workflowStreamEventSchema, type WorkflowStreamEvent } from './events';

export async function consumeWorkflowStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: WorkflowStreamEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const parsed = workflowStreamEventSchema.safeParse(JSON.parse(line));
          if (parsed.success) onEvent(parsed.data);
        } catch {
          // 不正行は無視
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
```

React からの使い方：

```typescript
const ctrl = new AbortController();
const res = await fetch('/api/<feature>', { method: 'POST', body: form, signal: ctrl.signal });
if (!res.ok || !res.body) throw new Error('failed');
await consumeWorkflowStream(res.body, (evt) => {
  if (evt.type === 'workflow.node')   setCurrentNode(evt.title);   // 進捗 UI
  if (evt.type === 'workflow.result') applyResult(evt.outputs);
  if (evt.type === 'error')           setError(evt.message);
}, ctrl.signal);
```

---

## 設計のポイント（迷ったらこの順で考える）

1. **生 fetch を選ぶ**：Workflow API は Chat ほどイベントが多くないので、SDK の抽象化は逆にノイズ。SSE のパースは 30 行で済む。
2. **`user` は一貫させる**：`difyUser(cfg, suffix)` で生成し、`uploadFileToDify` と `runWorkflow` で同じ値を使う。HITL ではないので 404 にはならないが、Dify ダッシュボードの実行履歴で同一セッションに紐付くメリットがある。
3. **Workflow ごとに API キーを分ける**：Dify は Workflow 単位で API キーを発行する。複数の Workflow を呼ぶなら getter (`getXxxWorkflowConfig`) と env を分け、URL prefix（`/workflows/run`）の使い回しと API キーの取り違いを分離する。
4. **Zod safeParse を再エミット直前にも噛ます**：サーバ側で型を握っていても、`safeParse` 失敗 → 黙ってドロップにしておくと、リファクタで壊した型がクライアントの実行時クラッシュにならない。
5. **`workflow.result` を出さずに SSE が閉じたら必ずエラーを emit**：Dify Studio 側のスキーマ不一致は無音 hang になるので、検知ラインを必ず置く。
6. **`outputs.structured_output.X` と `outputs.X` 両対応**：Dify バージョン・End ブロック設定で揺れるため、`{ ...outputs.structured_output, ...outputs }` で merge してから個別キーを取り出す。
7. **`X-Accel-Buffering: no`**：Cloud Run / nginx でストリームがバッファされてしまう事故を防ぐ。
8. **`USE_DIFY=0` でサンプル経路に逃がす**：Dify を立ち上げずに UI 開発できる。Route Handler の早期 return で同じ NDJSON プロトコルを返せばクライアントは無改修。
9. **OTel `withSpan` で包む**：上流の `traceparent` / `x-cloud-trace-context` を引き回せば Cloud Trace で Dify 呼び出し含めて 1 トレースに収まる（`gcp-observability-nextjs` スキル参照）。

## 採用しない選択肢

- **`dify-client` SDK**：Workflow には不要な抽象化（会話 ID 管理、agent log パース等）が多い。Chatflow なら採用、Workflow なら生 fetch 推奨。
- **`response_mode: "blocking"`**：ノード進捗をユーザに見せられないし、長尺 Workflow が Cloud Run のリクエストタイムアウトで切れる。streaming + NDJSON 一択。
- **SSE をそのままブラウザに流す**：型安全に扱いづらく、`EventSource` は POST/multipart 不可なので、`fetch` の `ReadableStream` + NDJSON のほうが素直。
