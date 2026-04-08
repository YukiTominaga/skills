# LoggingService — 完全実装リファレンス（Next.js 版）

Hono 版との違い: Hono の `Context` の代わりに `traceparent` と `xCloudTraceContext` を引数で直接受け取る。

## src/lib/logging.ts（または lib/logging.service.ts）

```typescript
import { context, type Span, SpanStatusCode, trace } from '@opentelemetry/api';
import { randomUUID } from 'crypto';

const PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT ?? '';

export class LoggingService {
  private tracer = trace.getTracer('logging-service');

  /** W3C traceparent: 00-{traceId}-{spanId}-{flags} */
  private extractTraceId(traceparent?: string): string | null {
    if (!traceparent) return null;
    const parts = traceparent.split('-');
    return parts.length === 4 && parts[0] === '00' ? parts[1] : null;
  }

  /** X-Cloud-Trace-Context: TRACE_ID/SPAN_ID;o=TRACE_TRUE */
  private extractTraceIdFromXCloudTraceContext(header?: string): string | null {
    if (!header) return null;
    const [traceAndSpan] = header.split(';', 1);
    const [traceId] = (traceAndSpan ?? '').split('/', 1);
    if (!traceId || !/^[0-9a-fA-F]{16,32}$/.test(traceId)) return null;
    return traceId;
  }

  private getCurrentTraceInfo(): { traceId: string | null; spanId: string | null } {
    const activeSpan = trace.getActiveSpan();
    if (!activeSpan) return { traceId: null, spanId: null };
    const ctx = activeSpan.spanContext();
    return { traceId: ctx.traceId, spanId: ctx.spanId };
  }

  /**
   * Cloud Logging の trace 相関フィールドを付与
   * 優先順位: traceparent > x-cloud-trace-context > active span
   */
  private addTraceContext(
    logEntry: Record<string, unknown>,
    traceparent?: string,
    xCloudTraceContext?: string,
  ): void {
    const current = this.getCurrentTraceInfo();
    const traceId =
      this.extractTraceId(traceparent) ??
      this.extractTraceIdFromXCloudTraceContext(xCloudTraceContext) ??
      current.traceId;

    if (traceId) {
      logEntry['logging.googleapis.com/trace'] = `projects/${PROJECT_ID}/traces/${traceId}`;
      if (current.spanId) {
        logEntry['logging.googleapis.com/spanId'] = current.spanId;
      }
      const activeSpan = trace.getActiveSpan();
      if (activeSpan) {
        logEntry['logging.googleapis.com/traceSampled'] =
          (activeSpan.spanContext().traceFlags & 1) === 1;
      }
    }
  }

  private createLogEntry(
    severity: 'INFO' | 'WARNING' | 'ERROR' | 'DEBUG',
    message: string,
    data?: unknown,
    traceparent?: string,
    xCloudTraceContext?: string,
  ): string {
    const logEntry: Record<string, unknown> = {
      severity,
      message,
      ...(data !== undefined && data !== null ? { data } : {}),
    };
    this.addTraceContext(logEntry, traceparent, xCloudTraceContext);
    console.log(JSON.stringify(logEntry));
    return randomUUID();
  }

  private createErrorLogEntry(
    message: string,
    error?: Error | unknown,
    traceparent?: string,
    xCloudTraceContext?: string,
  ): string {
    const errorLog: Record<string, unknown> = {
      '@type': 'type.googleapis.com/google.devtools.clouderrorreporting.v1beta1.ReportedErrorEvent',
      message,
      severity: 'ERROR',
    };
    if (error instanceof Error && error.stack) {
      errorLog.message = `${message}: ${error.message}`;
      errorLog.stack_trace = error.stack;
    }
    this.addTraceContext(errorLog, traceparent, xCloudTraceContext);
    console.log(JSON.stringify(errorLog));
    return randomUUID();
  }

  logInfo(message: string, data?: unknown, traceparent?: string, xCloudTraceContext?: string): string {
    return this.createLogEntry('INFO', message, data, traceparent, xCloudTraceContext);
  }

  logWarn(message: string, data?: unknown, traceparent?: string, xCloudTraceContext?: string): string {
    return this.createLogEntry('WARNING', message, data, traceparent, xCloudTraceContext);
  }

  logError(message: string, error?: Error | unknown, traceparent?: string, xCloudTraceContext?: string): string {
    return this.createErrorLogEntry(message, error, traceparent, xCloudTraceContext);
  }

  logDebug(message: string, data?: unknown, traceparent?: string, xCloudTraceContext?: string): string {
    return this.createLogEntry('DEBUG', message, data, traceparent, xCloudTraceContext);
  }

  /** カスタム span でラップ。エラー時に自動で recordException + setStatus(ERROR) */
  async withSpan<T>(spanName: string, fn: (span: Span) => Promise<T>): Promise<T> {
    const span = this.tracer.startSpan(spanName);
    return await context.with(trace.setSpan(context.active(), span), async () => {
      try {
        const result = await fn(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : 'Unknown error',
        });
        if (error instanceof Error) span.recordException(error);
        this.createErrorLogEntry(`Error in span: ${spanName}`, error);
        throw error;
      } finally {
        span.end();
      }
    });
  }
}
```

## Route Handler での使い方

```typescript
// app/api/something/route.ts
import { context, trace, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { LoggingService } from '@/lib/logging';

const tracer = trace.getTracer('something-api', '1.0.0');
const logger = new LoggingService();

export async function POST(request: Request) {
  const traceparent = request.headers.get('traceparent') ?? undefined;
  const xCloudTraceContext = request.headers.get('x-cloud-trace-context') ?? undefined;

  const span = tracer.startSpan('something.process', { kind: SpanKind.INTERNAL });
  try {
    return await context.with(trace.setSpan(context.active(), span), async () => {
      try {
        const body = await request.json();
        logger.logInfo('processing started', { bodySize: JSON.stringify(body).length }, traceparent, xCloudTraceContext);

        const result = await doWork(body);

        logger.logInfo('processing completed', { resultCount: result.length }, traceparent, xCloudTraceContext);
        span.setStatus({ code: SpanStatusCode.OK });
        return Response.json(result);
      } catch (err) {
        logger.logError('processing failed', err, traceparent, xCloudTraceContext);
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
        throw err;
      } finally {
        span.end();
      }
    });
  } catch (err) {
    return Response.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
```

## Server Component での使い方

```typescript
// app/dashboard/page.tsx
import { context, trace, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { LoggingService } from '@/lib/logging';
import { headers } from 'next/headers';

const tracer = trace.getTracer('dashboard', '1.0.0');
const logger = new LoggingService();

async function getDashboardData() {
  // Server Component では next/headers でヘッダーを取得
  const headersList = await headers();
  const traceparent = headersList.get('traceparent') ?? undefined;
  const xCloudTraceContext = headersList.get('x-cloud-trace-context') ?? undefined;

  const span = tracer.startSpan('dashboard.getData', { kind: SpanKind.INTERNAL });
  return await context.with(trace.setSpan(context.active(), span), async () => {
    try {
      const data = await fetchData();
      logger.logInfo('dashboard data fetched', { count: data.length }, traceparent, xCloudTraceContext);
      span.setStatus({ code: SpanStatusCode.OK });
      return data;
    } catch (err) {
      logger.logError('dashboard data fetch failed', err, traceparent, xCloudTraceContext);
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      span.end();
    }
  });
}

export default async function DashboardPage() {
  const data = await getDashboardData();
  return <div>{/* ... */}</div>;
}
```
