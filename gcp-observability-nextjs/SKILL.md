---
name: gcp-observability-nextjs
description: Next.js App Router アプリケーションに Google Cloud Trace (Telemetry API 直接送信 OTLP) と Cloud Logging 構造化ロギングを実装するスキル。instrumentation.ts フック、ADC を使ったトークン自動更新エクスポーター、traceparent 伝播、Route Handler / Server Component での手動 span パターン、LoggingService パターンを扱う。GCP 可観測性、Cloud Trace、Cloud Logging、traceparent、opentelemetry、Next.js に関する実装を行うときに使用する。
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
      → tracer.startActiveSpan()   ← 手動 span
      → LoggingService             ← 構造化ログ (trace 情報付き)
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
GOOGLE_CLOUD_QUOTA_PROJECT=your-project-id  # authorized_user の場合のみ
OTEL_RESOURCE_ATTRIBUTES="gcp.project_id=xxx,service.name=my-service,service.version=1.0.0"
```

## 2. Route Handler での span パターン

```typescript
// app/api/something/route.ts
import { trace, SpanStatusCode, SpanKind } from '@opentelemetry/api';

const tracer = trace.getTracer('something-api', '1.0.0');

export async function POST(request: Request) {
  return await tracer.startActiveSpan('something.process', async (span) => {
    try {
      const body = await request.json();
      span.setAttribute('request.size', JSON.stringify(body).length);

      const result = await doWork(body);
      span.setAttribute('result.count', result.length);
      span.setStatus({ code: SpanStatusCode.OK });

      return Response.json(result);
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      return Response.json({ error: 'Internal Server Error' }, { status: 500 });
    } finally {
      span.end();  // finally で必ず end する
    }
  });
}
```

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

  return await tracer.startActiveSpan('something.process', async (span) => {
    try {
      logger.logInfo('processing started', undefined, traceparent, xCloudTraceContext);
      // 処理...
      logger.logInfo('processing completed', { result }, traceparent, xCloudTraceContext);
      return Response.json(result);
    } catch (err) {
      logger.logError('processing failed', err, traceparent, xCloudTraceContext);
      return Response.json({ error: '...' }, { status: 500 });
    } finally {
      span.end();
    }
  });
}
```

## 4. Hono 版との違い

| 項目 | Hono | Next.js App Router |
|------|------|-------------------|
| 初期化場所 | `--import` プリロード（`tracing-preload.ts`） | `instrumentation.ts` の `register()` |
| ESM ホイスト問題 | あり（`--import` プリロードで解決） | なし（Next.js が適切なタイミングで呼ぶ） |
| ミドルウェア | `@hono/otel` の `httpInstrumentationMiddleware` | 不要（`HttpInstrumentation` が自動計装） |
| Context 渡し | `c: Context` 経由 | `request.headers.get()` で直接取得 |
| span API | `startActiveSpan` が推奨 | `startActiveSpan` が推奨 |

## 5. SpanKind の選択基準

| Kind | 使いどころ |
|------|-----------|
| `SERVER` | Route Handler の外側 HTTP span（自動設定） |
| `CLIENT` | 外部 API・DB 呼び出し（BigQuery, Discovery Engine など） |
| `INTERNAL` | LLM 推論・ビジネスロジックなど内部処理 |

`startActiveSpan` はデフォルトで `INTERNAL`。HTTP 外部呼び出しには明示的に `kind: SpanKind.CLIENT` を指定する。

## 6. よくあるトラブル

| 症状 | 原因 | 対処 |
|------|------|------|
| 1時間後に 401 エラー | `OTLPTraceExporter` 直接使用 | `GoogleAuthOTLPExporter` でラップ |
| ログに trace 情報が付かない | `LoggingService` を使わず `console.log` を直接使用 | `logInfo` などを使う |
| Cloud Trace にトレースが表示されない | `GOOGLE_CLOUD_PROJECT` 未設定 / IAM 権限不足 | `roles/cloudtrace.agent` を付与 |
| Edge Runtime でクラッシュ | `instrumentation-node.ts` を Edge でも import している | `NEXT_RUNTIME === 'nodejs'` で条件分岐 |
| `register()` が呼ばれない | Next.js 14以前で設定漏れ | `next.config.ts` に `instrumentationHook: true` を追加 |
