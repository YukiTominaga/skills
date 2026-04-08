# tracing — 完全実装リファレンス

## instrumentation.ts（プロジェクトルート）

```typescript
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./instrumentation-node');
  }
}
```

## instrumentation-node.ts

```typescript
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { CompositePropagator, ExportResultCode, W3CTraceContextPropagator } from '@opentelemetry/core';
import { CloudPropagator } from '@google-cloud/opentelemetry-cloud-trace-propagator';
import { GoogleAuth } from 'google-auth-library';
import type { AuthClient } from 'google-auth-library';
import type { ExportResult } from '@opentelemetry/core';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';

const TELEMETRY_ENDPOINT = 'https://telemetry.googleapis.com/v1/traces';

/**
 * export() のたびに ADC からトークンを取得し、
 * トークンが変わったときのみ内部エクスポーターを再生成する。
 */
class GoogleAuthOTLPExporter implements SpanExporter {
  private readonly authClient: AuthClient;
  private innerExporter: OTLPTraceExporter | null = null;
  private cachedToken: string | null = null;

  constructor(authClient: AuthClient) {
    this.authClient = authClient;
  }

  private async resolveExporter(): Promise<OTLPTraceExporter> {
    const { token } = await this.authClient.getAccessToken();
    if (!token) throw new Error('Failed to obtain access token from ADC');

    if (token !== this.cachedToken || this.innerExporter === null) {
      void this.innerExporter?.shutdown();
      const isRefresh = this.cachedToken !== null;
      this.cachedToken = token;

      const quotaProject = process.env.GOOGLE_CLOUD_QUOTA_PROJECT ?? '';
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        ...(quotaProject ? { 'x-goog-user-project': quotaProject } : {}),
      };

      this.innerExporter = new OTLPTraceExporter({ url: TELEMETRY_ENDPOINT, headers });
      console.log(`[OTel:token] ${isRefresh ? 'refreshed' : 'initialized'} token=${token.slice(0, 10)}...`);
    }

    return this.innerExporter;
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    this.resolveExporter()
      .then((exporter) =>
        exporter.export(spans, (result) => {
          if (result.error) {
            console.error(`[OTel:export] FAILED: ${result.error.message}`);
          } else {
            console.log(`[OTel:export] OK: ${spans.length} span(s) sent`);
          }
          resultCallback(result);
        }),
      )
      .catch((err: Error) => {
        console.error(`[OTel:export] ERROR: ${err.message}`);
        resultCallback({ code: ExportResultCode.FAILED, error: err });
      });
  }

  async shutdown(): Promise<void> {
    await this.innerExporter?.shutdown();
    this.innerExporter = null;
  }
}

const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
const authClient = await auth.getClient();

const { token: initToken } = await authClient.getAccessToken();
if (!initToken) throw new Error('Failed to obtain access token from ADC');

console.log('[OTel:init] auth ok');
console.log(`[OTel:init]   GOOGLE_CLOUD_PROJECT       : ${process.env.GOOGLE_CLOUD_PROJECT ?? '(not set)'}`);
console.log(`[OTel:init]   GOOGLE_CLOUD_QUOTA_PROJECT : ${process.env.GOOGLE_CLOUD_QUOTA_PROJECT ?? '(not set)'}`);
console.log(`[OTel:init]   OTEL_RESOURCE_ATTRIBUTES   : ${process.env.OTEL_RESOURCE_ATTRIBUTES ?? '(not set)'}`);

const sdk = new NodeSDK({
  traceExporter: new GoogleAuthOTLPExporter(authClient),
  instrumentations: [
    new HttpInstrumentation(),  // Next.js 内部の HTTP を自動計装
  ],
  textMapPropagator: new CompositePropagator({
    propagators: [new W3CTraceContextPropagator(), new CloudPropagator()],
  }),
});

sdk.start();
console.log('[OTel:init] SDK started');

process.on('SIGTERM', async () => {
  await sdk.shutdown().catch(console.error);
  process.exit(0);
});
```

## 必要な IAM ロール

| ロール | 用途 |
|--------|------|
| `roles/cloudtrace.agent` | Cloud Trace へのトレース書き込み |
| `roles/telemetry.tracesWriter` | Telemetry API (OTLP) へのトレース書き込み |
| `roles/logging.logWriter` | Cloud Logging への書き込み（Cloud Run は自動付与） |

## OTEL_RESOURCE_ATTRIBUTES の推奨設定

```bash
OTEL_RESOURCE_ATTRIBUTES="gcp.project_id=my-project,service.name=my-service,service.namespace=default,service.version=1.0.0"
```

## 外部呼び出しの span パターン

```typescript
import { context, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';

const tracer = trace.getTracer('my-api', '1.0.0');

// startSpan + context.with（明示的なコンテキスト伝播）
const span = tracer.startSpan('bigquery.query', { kind: SpanKind.CLIENT });
const result = await context.with(trace.setSpan(context.active(), span), async () => {
  span.setAttribute('db.system', 'bigquery');
  try {
    const r = await runQuery(sql);
    span.setAttribute('db.rows_returned', r.length);
    span.setStatus({ code: SpanStatusCode.OK });
    return r;
  } catch (err) {
    span.recordException(err as Error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
    throw err;
  } finally {
    span.end();
  }
});
```
