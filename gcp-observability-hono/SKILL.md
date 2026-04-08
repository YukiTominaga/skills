---
name: gcp-observability-hono
description: Hono + Node.js アプリケーションに Google Cloud Trace (Telemetry API 直接送信 OTLP) と Cloud Logging 構造化ロギングを実装するスキル。OpenTelemetry SDK の初期化、ADC を使ったトークン自動更新エクスポーター、traceparent 伝播、LoggingService パターンを扱う。GCP 可観測性、Cloud Trace、Cloud Logging、traceparent、opentelemetry、hono に関する実装を行うときに使用する。
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
  → Hono (@hono/otel middleware)  ← traceparent/x-cloud-trace-context を抽出
  → Route Handler
      → tracer.startActiveSpan()   ← 手動 span
      → LoggingService             ← 構造化ログ (trace 情報付き)
  → Cloud Trace (Telemetry API OTLP)
  → Cloud Logging (stdout JSON)
```

## 1. トレース初期化 (src/config/tracing.ts)

詳細実装は [tracing-reference.md](tracing-reference.md) を参照。

### 重要な設計ポイント

**ESM インポート順序問題 → `--import` プリロードで解決**

`import` はホイストされるため、`index.ts` 内でいかなる順序で書いても、`@hono/node-server` は `startTracing()` より前にロードされる。
`--import` フラグで `index.ts` より先にプリロードファイルを完全実行することで `HttpInstrumentation` が確実に `http` にパッチを当てる。

```typescript
// src/config/tracing-preload.ts
import { startTracing } from './tracing.js';

await startTracing();
```

```typescript
// src/index.ts — 通常の static import のままでよい
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { httpInstrumentationMiddleware } from '@hono/otel';
// ...
```

```json
// package.json
"scripts": {
  "dev": "tsx watch --import ./src/config/tracing-preload.ts src/index.ts",
  "build": "tsc",
  "start": "node --import ./dist/config/tracing-preload.js dist/index.js"
}
```

```dockerfile
# Dockerfile — npm start 経由だとシグナルが届かないため node を直接呼ぶ
CMD ["node", "--import", "./dist/config/tracing-preload.js", "dist/index.js"]
```

**トークン自動更新**
`OTLPTraceExporter` は初期化時にトークンを固定するため、1時間後に 401 エラーが発生する。
`export()` 呼び出しのたびにトークンを再取得する `GoogleAuthOTLPExporter` クラスでラップすること。

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
GOOGLE_CLOUD_QUOTA_PROJECT=your-project-id  # authorized_user の場合のみ
OTEL_RESOURCE_ATTRIBUTES="gcp.project_id=xxx,service.name=my-service,service.version=1.0.0"
```

## 2. Hono ミドルウェア設定 (index.ts)

```typescript
const otelMiddleware = httpInstrumentationMiddleware();
app.use('*', (c, next) => {
  // ヘルスチェックや静的エンドポイントをトレース除外
  if (c.req.path === '/' || c.req.path === '/openapi.yaml') return next();
  return otelMiddleware(c, next);
});
```

`HttpInstrumentation` 側の `ignoreIncomingRequestHook` も同じパスに合わせること。

```typescript
new HttpInstrumentation({
  ignoreIncomingRequestHook: (req) => {
    return req.url === '/' || req.url === '/openapi.yaml';
  },
}),
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
ログメソッドの戻り値は `void`。

### traceId 優先順位

1. `traceparent` ヘッダー (W3C Trace Context)
2. `X-Cloud-Trace-Context` ヘッダー (Google Cloud 独自形式)
3. アクティブな OTel span から取得

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

### 推奨: `startActiveSpan`

`startActiveSpan` を使うこと。自動で現在の active context を親にし、コールバック内でスパンがアクティブになる。

```typescript
import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';

const tracer = trace.getTracer('my-route', '1.0.0');

// ルートハンドラー内での基本パターン
app.post('/something', async (c) => {
  let result;
  try {
    result = await tracer.startActiveSpan(
      'my-operation',
      { kind: SpanKind.CLIENT, attributes: { 'db.system': 'bigquery' } },
      async (span) => {
        try {
          const r = await externalCall();
          span.setAttribute('result.count', r.length);
          span.setStatus({ code: SpanStatusCode.OK });
          return r;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          span.recordException(err instanceof Error ? err : new Error(message));
          span.setStatus({ code: SpanStatusCode.ERROR, message });
          throw err;  // re-throw して外側の catch でレスポンス返却
        } finally {
          span.end();  // finally で必ず 1 回だけ end する
        }
      },
    );
  } catch (err) {
    return c.json({ error: '...' }, 500);
  }
  return c.json({ result });
});
```

### ネスト構造 (親子 span) — Cloud Trace ウォーターフォール表示

`startActiveSpan` はコールバック内でそのスパンをアクティブにするため、**コールバック内でさらに `startActiveSpan` を呼ぶだけで子スパンになる**。`context.with` による手動伝播は不要。

```typescript
// Cloud Trace に表示される構造:
// HTTP span (POST /tools/qa/summary)
//   └── qa.summary (parent, INTERNAL)
//        ├── qa.generateQuery (child, INTERNAL)
//        └── qa.search       (child, CLIENT)

app.post('/summary', async (c) => {
  try {
    const response = await tracer.startActiveSpan(
      'qa.summary',
      { kind: SpanKind.INTERNAL, attributes: { 'llm.question': question } },
      async (parentSpan) => {
        try {
          // 子スパン 1 — parentSpan がアクティブなので自動的に子になる
          const query = await tracer.startActiveSpan(
            'qa.generateQuery',
            { kind: SpanKind.INTERNAL },
            async (span) => {
              try {
                const q = await generateSearchQuery(question);
                span.setAttribute('llm.generated_query', q);
                span.setStatus({ code: SpanStatusCode.OK });
                return q;
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                span.recordException(err instanceof Error ? err : new Error(message));
                span.setStatus({ code: SpanStatusCode.ERROR, message });
                throw err;
              } finally {
                span.end();
              }
            },
          );

          // 子スパン 2 — parentSpan がアクティブなので自動的に子になる
          const result = await tracer.startActiveSpan(
            'qa.search',
            { kind: SpanKind.CLIENT, attributes: { 'search.query': query } },
            async (span) => {
              try {
                const r = await search(query);
                span.setAttribute('search.result_count', r.length);
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
            },
          );

          parentSpan.setAttribute('result.count', result.length);
          parentSpan.setStatus({ code: SpanStatusCode.OK });
          return c.json({ query, result });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          parentSpan.recordException(err instanceof Error ? err : new Error(message));
          parentSpan.setStatus({ code: SpanStatusCode.ERROR, message });
          throw err;
        } finally {
          parentSpan.end();
        }
      },
    );
    return response;
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});
```

**ポイント:**
- `startActiveSpan` のコールバック内では、そのスパンが自動的に active context になる
- 入れ子で `startActiveSpan` を呼ぶだけで自動的に親子関係が形成される
- `context.with(trace.setSpan(...))` による手動伝播は不要

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

`startActiveSpan` + `throw err` パターンに統一することでこのバグを根本的に防げる。

### withSpan ヘルパー (LoggingService) — エラー処理を自動化したい場合

```typescript
await logger.withSpan('my-operation', async (span) => {
  span.setAttribute('key', 'value');
  return await doSomething();
  // エラー時は自動で span.recordException + setStatus(ERROR)
});
```

## 5. SpanKind の選択基準

| Kind | 使いどころ |
|------|-----------|
| `SERVER` | 受信 HTTP リクエスト（`@hono/otel` が自動設定） |
| `CLIENT` | 外部 API・DB 呼び出し（BigQuery, Discovery Engine など） |
| `INTERNAL` | LLM 推論・ビジネスロジックなど内部処理 |

## 6. よくあるトラブル

| 症状 | 原因 | 対処 |
|------|------|------|
| カスタム span が HTTP trace と別々に表示される | `--import` プリロードなしで起動した / `HttpInstrumentation` が `http` にパッチ未適用 | `--import ./dist/config/tracing-preload.js` を起動コマンドに追加 |
| 1時間後に 401 エラー | `OTLPTraceExporter` 直接使用 | `GoogleAuthOTLPExporter` でラップ |
| ログに trace 情報が付かない | `LoggingService` を使わず `console.log` を直接使用 | `logInfoWithContext` などを使う |
| Cloud Trace にトレースが表示されない | `GOOGLE_CLOUD_PROJECT` 未設定 / IAM 権限不足 | `roles/cloudtrace.agent` を付与 |
| tsx dev でエラー `Cannot find module 'watch'` | `--import` を `watch` サブコマンドより前に置いた | `tsx watch --import ./preload.ts src/index.ts` の順にする |
| span データが壊れている / Cloud Trace で span の時刻が異常 | `catch` と `finally` の両方で `span.end()` を呼んでいる（二重呼び出し） | `startActiveSpan` + `throw err` パターンに統一し、`finally` のみで `span.end()` を呼ぶ |
