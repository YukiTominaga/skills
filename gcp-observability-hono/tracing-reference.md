# tracing.ts — 完全実装リファレンス

## src/config/tracing.ts

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

let sdk: NodeSDK | null = null;

export async function startTracing(): Promise<void> {
  try {
    const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
    const authClient = await auth.getClient();

    const { token: initToken } = await authClient.getAccessToken();
    if (!initToken) throw new Error('Failed to obtain access token from ADC');

    console.log('[OTel:init] auth ok');
    console.log(`[OTel:init]   GOOGLE_CLOUD_PROJECT       : ${process.env.GOOGLE_CLOUD_PROJECT ?? '(not set)'}`);
    console.log(`[OTel:init]   GOOGLE_CLOUD_QUOTA_PROJECT : ${process.env.GOOGLE_CLOUD_QUOTA_PROJECT ?? '(not set)'}`);
    console.log(`[OTel:init]   OTEL_RESOURCE_ATTRIBUTES   : ${process.env.OTEL_RESOURCE_ATTRIBUTES ?? '(not set)'}`);

    sdk = new NodeSDK({
      traceExporter: new GoogleAuthOTLPExporter(authClient),
      instrumentations: [
        new HttpInstrumentation({
          ignoreIncomingRequestHook: (req) => req.url === '/health',
        }),
      ],
      textMapPropagator: new CompositePropagator({
        propagators: [new W3CTraceContextPropagator(), new CloudPropagator()],
      }),
    });

    sdk.start();
    console.log('[OTel:init] SDK started');
  } catch (error) {
    console.error('[OTel:init] FAILED to initialize:', error);
  }
}

export async function stopTracing(): Promise<void> {
  if (!sdk) return;
  try {
    await sdk.shutdown();
    console.log('[OTel:shutdown] shut down successfully');
  } catch (error) {
    console.error('[OTel:shutdown] Failed:', error);
  }
}

process.on('SIGTERM', async () => { await stopTracing(); process.exit(0); });
process.on('SIGINT', async () => { await stopTracing(); process.exit(0); });
```

## src/index.ts のエントリポイント構成

```typescript
// OpenTelemetryの初期化を最初に実行
import { startTracing } from './config/tracing.js';
await startTracing();

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { httpInstrumentationMiddleware } from '@hono/otel';
import myRoute from './routes/my-route.js';

const app = new Hono();

const otelMiddleware = httpInstrumentationMiddleware();
app.use('*', (c, next) => {
  if (c.req.path === '/health') return next();
  return otelMiddleware(c, next);
});

app.route('/tools/something', myRoute);
app.get('/', (c) => c.json({ status: 'ok' }));
app.get('/health', (c) => c.json({ status: 'ok' }));

serve({ fetch: app.fetch, port: Number(process.env.PORT) || 3000 }, (info) => {
  console.log(`Server is running on http://localhost:${info.port}`);
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
