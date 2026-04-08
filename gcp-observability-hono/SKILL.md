---
name: gcp-observability-hono
description: Hono + Node.js アプリケーションに Google Cloud Trace (Telemetry API 直接送信 OTLP) と Cloud Logging 構造化ロギングを実装するスキル。OpenTelemetry SDK の初期化、ADC を使ったトークン自動更新エクスポーター、startSpan + context.with() による手動 span パターン、httpInstrumentationMiddleware との組み合わせ、LoggingService パターンを扱う。GCP 可観測性、Cloud Trace、Cloud Logging、traceparent、opentelemetry、hono に関する実装を行うときに使用する。
---

# GCP Observability for Hono

Google Cloud Trace + Cloud Logging を Hono (Node.js) アプリケーションに組み込むパターン。

## 依存パッケージ

```bash
npm install @opentelemetry/api @opentelemetry/core @opentelemetry/sdk-node \
  @opentelemetry/instrumentation-http @opentelemetry/exporter-trace-otlp-http \
  @google-cloud/opentelemetry-cloud-trace-propagator \
  @hono/otel google-auth-library
```

## アーキテクチャ概要

```
リクエスト
  → HttpInstrumentation (NodeSDK, http モジュールレベル)  ← 自動でHTTPスパン作成
  → httpInstrumentationMiddleware (@hono/otel)            ← Hono ルート名を span に反映
  → Hono Route Handler
      → tracer.startSpan() + context.with()   ← 手動 span（httpInstrumentationMiddleware スパンの子になる）
      → LoggingService                         ← 構造化ログ (trace 情報付き)
  → Cloud Trace (Telemetry API OTLP)
  → Cloud Logging (stdout JSON)
```

## 1. トレース初期化 (src/config/tracing.ts)

詳細実装は [tracing-reference.md](tracing-reference.md) を参照。

### 重要な設計ポイント

**`index.ts` の先頭で `await startTracing()` を明示的に呼ぶ**

```typescript
// src/index.ts
// OpenTelemetryの初期化を最初に実行
import { startTracing } from './config/tracing.js';
await startTracing();

import { serve } from '@hono/node-server';
import { httpInstrumentationMiddleware } from '@hono/otel';
import { Hono } from 'hono';
// ...
```

ESM では static import はすべてホイストされるが、`await startTracing()` は `serve()` より確実に先に実行される。`HttpInstrumentation` の http モジュールへのパッチは `sdk.start()` のタイミングで適用されるため、サーバーが接続を受け付ける前に確実に完了する。

**トークン自動更新**
`OTLPTraceExporter` は初期化時にトークンを固定するため、1時間後に 401 エラーが発生する。
`export()` 呼び出しのたびにトークンを再取得する `GoogleAuthOTLPExporter` クラスでラップすること。

**デバッグログ**
`export()` に以下のログを入れること。export の成功/失敗が Cloud Run ログで即座に確認できる。
```
[OTel:init] SDK started
[OTel:export] exporting N span(s)
[OTel:export] OK: N span(s) sent
[OTel:export] FAILED: ...
[OTel:export] ERROR (token/auth): ...
```

**エンドポイント**
```
https://telemetry.googleapis.com/v1/traces
```

**Propagator**（両方必要）
```typescript
textMapPropagator: new CompositePropagator({
  propagators: [new W3CTraceContextPropagator(), new CloudPropagator()],
}),
```

**環境変数**
```bash
GOOGLE_CLOUD_PROJECT=your-project-id
GOOGLE_CLOUD_QUOTA_PROJECT=your-project-id  # authorized_user (ローカル開発) の場合のみ
OTEL_RESOURCE_ATTRIBUTES="gcp.project_id=xxx,service.name=my-service,service.version=1.0.0"
```

## 2. Hono ミドルウェア設定 (index.ts)

`HttpInstrumentation`（NodeSDK）と `httpInstrumentationMiddleware`（`@hono/otel`）の両方を使う。
`HttpInstrumentation` が Node.js HTTP レベルでスパンを作成し、`httpInstrumentationMiddleware` が Hono のルートパターン（`GET /tools/qa/summary` など）をスパン名に反映する。

```typescript
// src/index.ts
import { httpInstrumentationMiddleware } from '@hono/otel';

const otelMiddleware = httpInstrumentationMiddleware();
app.use('*', (c, next) => {
  if (c.req.path === '/health') return next();  // ヘルスチェックはトレース除外
  return otelMiddleware(c, next);
});

app.get('/health', (c) => c.json({ status: 'ok' }));
```

`HttpInstrumentation` 側でも同じパスを除外すること。

```typescript
new HttpInstrumentation({
  ignoreIncomingRequestHook: (req) => {
    return req.url === '/health';
  },
}),
```

これにより Cloud Trace に表示される構造:

```
(Missing parent: HttpInstrumentation span)
  └── GET /tools/qa/summary (httpInstrumentationMiddleware が作成)
        ├── qa.generateSearchQuery
        └── qa.summarize
```

## 3. 構造化ロギング (LoggingService)

詳細実装は [logging-reference.md](logging-reference.md) を参照。

### ログフォーマット (stdout JSON → Cloud Logging)

```json
{
  "severity": "INFO",
  "message": "処理完了",
  "data": { "rows": 42 },
  "logging.googleapis.com/trace": "projects/my-proj/traces/abc123...",
  "logging.googleapis.com/spanId": "def456...",
  "logging.googleapis.com/traceSampled": true
}
```

Cloud Logging は各ログエントリに `insertId` を自動付与するため、アプリ側で UUID を生成する必要はない。

### Hono ルートでの使い方

```typescript
const logger = new LoggingService();

app.post('/something', async (c) => {
  logger.logInfoWithContext(c, 'processing started', { inputSize: 42 });

  try {
    // 処理...
    logger.logInfoWithContext(c, 'processing completed', { result });
  } catch (err) {
    logger.logErrorWithContext(c, 'processing failed', err);
    return c.json({ error: '...' }, 500);
  }
});
```

## 4. 手動 Span パターン (ルートハンドラー)

### 推奨: `startSpan` + `context.with`

`tracer.startSpan()` でスパンを作成し、`context.with(trace.setSpan(context.active(), span), fn)` で明示的にコンテキストを伝播する。

```typescript
import { context, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';

const tracer = trace.getTracer('my-route', '1.0.0');

// ルートハンドラー内での基本パターン
app.post('/something', async (c) => {
  let result;
  try {
    const span = tracer.startSpan('my-operation', {
      kind: SpanKind.CLIENT,
      attributes: { 'db.system': 'bigquery' },
    });
    result = await context.with(trace.setSpan(context.active(), span), async () => {
      try {
        const r = await externalCall();
        span.setAttribute('result.count', r.length);
        span.setStatus({ code: SpanStatusCode.OK });
        return r;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        span.recordException(err instanceof Error ? err : new Error(message));
        span.setStatus({ code: SpanStatusCode.ERROR, message });
        throw err;
      } finally {
        span.end();
      }
    });
  } catch (err) {
    return c.json({ error: '...' }, 500);
  }
  return c.json({ result });
});
```

### 複数スパン（シーケンシャル）

`context.with()` の外側で `context.active()` を呼ぶと `httpInstrumentationMiddleware` のスパンが親になる。各スパンは HTTP スパンの直接の子（兄弟関係）になる。

```typescript
// Cloud Trace に表示される構造:
// GET /tools/qa/summary
//   ├── qa.generateSearchQuery
//   └── qa.summarize

app.post('/summary', zValidator('json', schema), async (c) => {
  const { question } = c.req.valid('json');
  let query: string;

  try {
    const span = tracer.startSpan('qa.generateSearchQuery', {
      kind: SpanKind.INTERNAL,
      attributes: { 'llm.question': question },
    });
    query = await context.with(trace.setSpan(context.active(), span), async () => {
      try {
        const q = await generateSearchQuery(question);
        span.setAttribute('llm.generated_query', q);
        span.setStatus({ code: SpanStatusCode.OK });
        logger.logInfoWithContext(c, 'qa.generateSearchQuery: completed', { query: q });
        return q;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        span.recordException(err instanceof Error ? err : new Error(message));
        span.setStatus({ code: SpanStatusCode.ERROR, message });
        throw err;
      } finally {
        span.end();
      }
    });
  } catch (err) {
    return c.json({ error: 'クエリ生成に失敗しました', detail: String(err) }, 500);
  }

  try {
    const span = tracer.startSpan('qa.summarize', {
      kind: SpanKind.CLIENT,
      attributes: { 'search.query': query },
    });
    const result = await context.with(trace.setSpan(context.active(), span), async () => {
      try {
        const r = await summarize(query);
        span.setAttribute('search.result_count', r.results.length);
        span.setStatus({ code: SpanStatusCode.OK });
        logger.logInfoWithContext(c, 'qa.summarize: completed', { resultCount: r.results.length });
        return r;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        span.recordException(err instanceof Error ? err : new Error(message));
        span.setStatus({ code: SpanStatusCode.ERROR, message });
        throw err;
      } finally {
        span.end();
      }
    });
    return c.json({ query, result });
  } catch (err) {
    return c.json({ error: '検索に失敗しました', detail: String(err) }, 500);
  }
});
```

### アンチパターン: `span.end()` の二重呼び出し（バグ）

`catch` と `finally` の両方で `span.end()` を呼ぶと、エラー発生時に必ず二重実行される。`startSpan` + `context.with` パターンで陥りやすい。

```typescript
// NG: catch と finally の両方で end している
const span = tracer.startSpan('op');
try {
  await doWork();
} catch (err) {
  span.recordException(err);
  span.end();   // 1回目
  return c.json({ error: '...' }, 500);
} finally {
  span.end();   // 2回目（バグ）— catch で return しても finally は実行される
}
```

`finally` のみで `span.end()` を呼び、エラーは `throw err` で再スローして外側の `catch` でレスポンスを返すパターンに統一すること。

## 5. SpanKind の選択基準

| Kind | 使いどころ |
|------|-----------|
| `SERVER` | 受信 HTTP リクエスト（`httpInstrumentationMiddleware` が自動設定） |
| `CLIENT` | 外部 API・DB 呼び出し（BigQuery, Discovery Engine など） |
| `INTERNAL` | LLM 推論・ビジネスロジックなど内部処理 |

## 6. IAM 権限

| ロール | 用途 |
|--------|------|
| `roles/cloudtrace.agent` | Cloud Trace へのスパン書き込み |
| `roles/telemetry.tracesWriter` | Telemetry API (OTLP) へのスパン書き込み |
| `roles/logging.logWriter` | Cloud Logging への書き込み |

**注意**: `x-goog-user-project` ヘッダーを送る場合は追加で `roles/serviceusage.serviceUsageConsumer` が必要。
ローカル開発（`UserRefreshClient`）では `GOOGLE_CLOUD_QUOTA_PROJECT` を設定するとこのヘッダーが自動付与される。
Cloud Run のサービスアカウントには `GOOGLE_CLOUD_QUOTA_PROJECT` を設定しない、または `serviceusage.serviceUsageConsumer` ロールを付与する。

## 7. よくあるトラブル

| 症状 | 原因 | 対処 |
|------|------|------|
| カスタム span が HTTP trace と別々に表示される | `context.active()` に HTTP スパンが含まれていない | `context.with(trace.setSpan(context.active(), span), fn)` を使い明示的に伝播する |
| 1時間後に 401 エラー | `OTLPTraceExporter` 直接使用 | `GoogleAuthOTLPExporter` でラップ |
| Cloud Run で 403 Forbidden | `x-goog-user-project` ヘッダーが送られている / `telemetry.googleapis.com` が未有効化 | `GOOGLE_CLOUD_QUOTA_PROJECT` を service.yaml から削除するか `roles/serviceusage.serviceUsageConsumer` を付与。APIが未有効の場合は `gcloud services enable telemetry.googleapis.com` |
| ログに trace 情報が付かない | `LoggingService` を使わず `console.log` を直接使用 | `logInfoWithContext` などを使う |
| Cloud Trace にトレースが表示されない | `GOOGLE_CLOUD_PROJECT` 未設定 / IAM 権限不足 | `roles/cloudtrace.agent` または `roles/telemetry.tracesWriter` を付与 |
| span データが壊れている | `catch` と `finally` の両方で `span.end()` を呼んでいる | `finally` のみで `span.end()` を呼ぶ |
| `[OTel:export] exporting` ログが出ない | SDK が初期化されていない（`startTracing()` 未呼び出し） | `index.ts` 先頭の `await startTracing()` を確認する |
