# LoggingService — 完全実装リファレンス

## src/types/logging.ts

```typescript
export interface LogStructureRequest {
  [key: string]: unknown;
}

export interface LogEntry {
  logId: string;
  severity: 'INFO' | 'WARNING' | 'ERROR' | 'DEBUG';
  message: string;
  data: unknown;
}
```

## src/services/logging.service.ts

```typescript
import { type Span, SpanStatusCode, trace } from '@opentelemetry/api';
import { randomUUID } from 'crypto';
import { config } from '../config/config.js';
import type { LogStructureRequest } from '../types/logging.js';
import type { Context } from 'hono';

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
      logEntry['logging.googleapis.com/trace'] = `projects/${config.projectId}/traces/${traceId}`;
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

  private resolveTraceHeadersFromContext(
    c: Context,
  ): { traceparent?: string; xCloudTraceContext?: string } {
    return {
      traceparent:
        (c.get?.('traceparent') as string | undefined) ??
        c.req.header('traceparent') ??
        undefined,
      xCloudTraceContext:
        (c.get?.('xCloudTraceContext') as string | undefined) ??
        c.req.header('x-cloud-trace-context') ??
        undefined,
    };
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

  logStructuredData(data: LogStructureRequest, traceparent?: string, xCloudTraceContext?: string): string {
    const structuredLog: Record<string, unknown> = { message: 'Request body logged', severity: 'INFO', ...data };
    this.addTraceContext(structuredLog, traceparent, xCloudTraceContext);
    console.log(JSON.stringify(structuredLog));
    return randomUUID();
  }

  private createErrorLogEntry(message: string, error?: Error | unknown, traceparent?: string, xCloudTraceContext?: string): string {
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

  // Hono Context を受け取るショートハンドメソッド群
  logStructuredDataWithContext(c: Context, data: LogStructureRequest): string {
    const { traceparent, xCloudTraceContext } = this.resolveTraceHeadersFromContext(c);
    return this.logStructuredData(data, traceparent, xCloudTraceContext);
  }

  logInfoWithContext(c: Context, message: string, data?: unknown): string {
    const { traceparent, xCloudTraceContext } = this.resolveTraceHeadersFromContext(c);
    return this.createLogEntry('INFO', message, data, traceparent, xCloudTraceContext);
  }

  logWarnWithContext(c: Context, message: string, data?: unknown): string {
    const { traceparent, xCloudTraceContext } = this.resolveTraceHeadersFromContext(c);
    return this.createLogEntry('WARNING', message, data, traceparent, xCloudTraceContext);
  }

  logErrorWithContext(c: Context, message: string, error?: Error | unknown): string {
    const { traceparent, xCloudTraceContext } = this.resolveTraceHeadersFromContext(c);
    return this.createErrorLogEntry(message, error, traceparent, xCloudTraceContext);
  }

  logDebugWithContext(c: Context, message: string, data?: unknown): string {
    const { traceparent, xCloudTraceContext } = this.resolveTraceHeadersFromContext(c);
    return this.createLogEntry('DEBUG', message, data, traceparent, xCloudTraceContext);
  }

  /** カスタム span でラップ。エラー時に自動で recordException + setStatus(ERROR) */
  async withSpan<T>(spanName: string, fn: (span: Span) => Promise<T>): Promise<T> {
    return await this.tracer.startActiveSpan(spanName, async (span) => {
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

## src/config/config.ts（最低限）

```typescript
export const config = {
  projectId: process.env.GOOGLE_CLOUD_PROJECT ?? '',
};
```
