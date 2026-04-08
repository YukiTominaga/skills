---
name: gcp-observability-nextjs
description: Next.js App Router アプリケーションに Google Cloud Trace (Telemetry API 直接送信 OTLP) と Cloud Logging 構造化ロギングを実装するスキル。instrumentation.ts フック、ADC を使ったトークン自動更新エクスポーター、startSpan + context.with() による手動 span パターン、Route Handler / Server Component での実装、LoggingService パターンを扱う。GCP 可観測性、Cloud Trace、Cloud Logging、traceparent、opentelemetry、Next.js に関する実装を行うときに使用する。
---

# GCP Observability for Next.js App Router

Google Cloud Trace + Cloud Logging を Next.js (App Router) に組み込むパターン。

## 依存パッケージ

```bash
npm install @opentelemetry/api @opentelemetry/core @opentelemetry/sdk-node \
  @opentelemetry/instrumentation-http @opentelemetry/exporter-trace-otlp-http \
  @google-cloud/opentelemetry-cloud-trace-propagator \
  google-auth-library
```

## アーキテクチャ概要

```
リクエスト
  → Next.js (instrumentation.ts で OTel 初期化済み)
  → Route Handler / Server Component
      → tracer.startSpan() + context.with()   ← 手動 span
      → LoggingService                          ← 構造化ログ (trace 情報付き)
  → Cloud Trace (Telemetry API OTLP)
  → Cloud Logging (stdout JSON)
```

## 1. トレース初期化

### instrumentation.ts（プロジェクトルート）

Next.js は `register()` をサーバー起動時に一度だけ呼び出す。
Node.js ランタイム限定でトレース初期化を行う。
実装は `instrumentation.node.ts` に分離することで、Edge Runtime へのバンドルを防ぐ。

```typescript
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./instrumentation.node');
  }
}
```

### instrumentation.node.ts

詳細実装は [tracing-reference.md](tracing-reference.md) を参照。

**トークン自動更新（Hono 版と共通）**  
`OTLPTraceExporter` は初期化時にトークンを固定するため、1時間後に 401 エラーが発生する。
`export()` のたびにトークンを再取得する `GoogleAuthOTLPExporter` クラスでラップすること。

**デバッグログ**
`export()` に以下のログを入れること。export の成功/失敗が Cloud Run ログで即座に確認できる。
```
[OTel:init] SDK started
[OTel:export] exporting N span(s)
[OTel:export] OK: N span(s) sent
[OTel:export] FAILED: ...
[OTel:export] ERROR (token/auth): ...
```

**Propagator（両方必要）**
```typescript
textMapPropagator: new CompositePropagator({
  propagators: [new W3CTraceContextPropagator(), new CloudPropagator()],
}),
```

### next.config.ts

```typescript
const nextConfig: NextConfig = {
  // Next.js 15+ では不要（デフォルト有効）。14以前は必要。
  experimental: {
    instrumentationHook: true,
  },
};
```

**環境変数**
```bash
GOOGLE_CLOUD_PROJECT=your-project-id
GOOGLE_CLOUD_QUOTA_PROJECT=your-project-id  # authorized_user (ローカル開発) の場合のみ
OTEL_RESOURCE_ATTRIBUTES="gcp.project_id=xxx,service.name=my-service,service.version=1.0.0"
```

## 2. Route Handler での span パターン

### 推奨: `startSpan` + `context.with`

`tracer.startSpan()` でスパンを作成し、`context.with(trace.setSpan(context.active(), span), fn)` で明示的にコンテキストを伝播する。

```typescript
// app/api/something/route.ts
import { context, trace, SpanStatusCode, SpanKind } from '@opentelemetry/api';

const tracer = trace.getTracer('something-api', '1.0.0');

export async function POST(request: Request) {
  let result;
  try {
    const span = tracer.startSpan('something.process', { kind: SpanKind.INTERNAL });
    result = await context.with(trace.setSpan(context.active(), span), async () => {
      try {
        const body = await request.json();
        span.setAttribute('request.size', JSON.stringify(body).length);

        const r = await doWork(body);
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
    return Response.json({ error: 'Internal Server Error' }, { status: 500 });
  }
  return Response.json(result);
}
```

### ネスト構造（複数スパン）— Cloud Trace ウォーターフォール表示

`context.with()` 内で `context.active()` を呼ぶと、外側のスパンが親になる。
`context.with()` の外側（ルートハンドラ直下）で呼ぶと HTTP スパンが親になる。

```typescript
// Cloud Trace に表示される構造:
// HTTP span (POST /api/something)
//   ├── something.fetchData (child, CLIENT)
//   └── something.transform (child, INTERNAL)

export async function POST(request: Request) {
  const body = await request.json();
  let data;

  // スパン 1
  try {
    const span = tracer.startSpan('something.fetchData', {
      kind: SpanKind.CLIENT,
      attributes: { 'db.system': 'bigquery' },
    });
    data = await context.with(trace.setSpan(context.active(), span), async () => {
      try {
        const result = await fetchFromDB(body.query);
        span.setAttribute('db.rows_returned', result.length);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
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
    return Response.json({ error: 'fetch failed' }, { status: 500 });
  }

  // スパン 2
  let transformed;
  try {
    const span = tracer.startSpan('something.transform', { kind: SpanKind.INTERNAL });
    transformed = await context.with(trace.setSpan(context.active(), span), async () => {
      try {
        const result = transform(data);
        span.setAttribute('transform.output_count', result.length);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
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
    return Response.json({ error: 'transform failed' }, { status: 500 });
  }

  return Response.json(transformed);
}
```

### アンチパターン: `span.end()` の二重呼び出し（バグ）

`catch` と `finally` の両方で `span.end()` を呼ぶと、エラー発生時に必ず二重実行される。`startSpan` + `context.with` パターンで陥りやすい。

```typescript
// NG: catch と finally の両方で end している
const span = tracer.startSpan('op');
try {
  await doWork();
} catch (err) {
  span.recordException(err as Error);
  span.end();   // 1回目
  return Response.json({ error: '...' }, { status: 500 });
} finally {
  span.end();   // 2回目（バグ）— catch で return しても finally は実行される
}
```

`finally` のみで `span.end()` を呼び、エラーは `throw err` で再スローして外側の `catch` でレスポンスを返すパターンに統一すること。

## 3. 構造化ロギング (LoggingService)

詳細実装は [logging-reference.md](logging-reference.md) を参照。

Cloud Logging は各ログエントリに `insertId` を自動付与するため、アプリ側で UUID を生成する必要はない。
ログメソッドの戻り値は `void`。

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

### traceId 優先順位

1. `traceparent` ヘッダー (W3C Trace Context)
2. `X-Cloud-Trace-Context` ヘッダー (Google Cloud 独自形式)
3. アクティブな OTel span から取得

### Route Handler での使い方

```typescript
import { LoggingService } from '@/lib/logging';

const logger = new LoggingService();

export async function POST(request: Request) {
  const traceparent = request.headers.get('traceparent') ?? undefined;
  const xCloudTraceContext = request.headers.get('x-cloud-trace-context') ?? undefined;

  const span = tracer.startSpan('something.process', { kind: SpanKind.INTERNAL });
  try {
    return await context.with(trace.setSpan(context.active(), span), async () => {
      try {
        logger.logInfo('processing started', undefined, traceparent, xCloudTraceContext);
        // 処理...
        logger.logInfo('processing completed', { result }, traceparent, xCloudTraceContext);
        span.setStatus({ code: SpanStatusCode.OK });
        return Response.json(result);
      } catch (err) {
        logger.logError('processing failed', err, traceparent, xCloudTraceContext);
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw err;
      } finally {
        span.end();
      }
    });
  } catch (err) {
    return Response.json({ error: '...' }, { status: 500 });
  }
}
```

## 4. Hono 版との違い

| 項目 | Hono | Next.js App Router |
|------|------|-------------------|
| 初期化場所 | `index.ts` 先頭で `await startTracing()` | `instrumentation.ts` の `register()` |
| HTTP ミドルウェア | `httpInstrumentationMiddleware` + `HttpInstrumentation` | `HttpInstrumentation` のみ（自動計装） |
| Context 渡し | `c: Context` 経由 (`logInfoWithContext`) | `request.headers.get()` で直接取得 |
| span API | `startSpan` + `context.with()` | `startSpan` + `context.with()` |

## 5. SpanKind の選択基準

| Kind | 使いどころ |
|------|-----------|
| `SERVER` | Route Handler の外側 HTTP span（自動設定） |
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
| ログに trace 情報が付かない | `LoggingService` を使わず `console.log` を直接使用 | `logInfo` などを使う |
| Cloud Trace にトレースが表示されない | `GOOGLE_CLOUD_PROJECT` 未設定 / IAM 権限不足 | `roles/cloudtrace.agent` または `roles/telemetry.tracesWriter` を付与 |
| Edge Runtime でクラッシュ | `instrumentation-node.ts` を Edge でも import している | `NEXT_RUNTIME === 'nodejs'` で条件分岐 |
| `register()` が呼ばれない | Next.js 14以前で設定漏れ | `next.config.ts` に `instrumentationHook: true` を追加 |
| span データが壊れている | `catch` と `finally` の両方で `span.end()` を呼んでいる | `finally` のみで `span.end()` を呼ぶ |
| `[OTel:export] exporting` ログが出ない | SDK が初期化されていない | `instrumentation.ts` の `register()` が呼ばれているか確認 |
