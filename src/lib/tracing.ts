import { context, propagation, ROOT_CONTEXT, SpanKind, SpanStatusCode, trace, type Context, type Span } from "@opentelemetry/api";

// Manual spans that carry one trace across process hops: HTTP enqueue → outbox → queue → worker → callback.
// With no SDK registered (tests that don't care, OTEL_EXPORTER_OTLP_ENDPOINT unset) these are no-ops.
export const tracer = trace.getTracer("relayq");

type Carrier = Record<string, string | string[] | undefined>;

/** Runs fn in a span that continues the trace in `headers` (W3C traceparent), or starts a new one. */
export function withSpan<T>(name: string, kind: SpanKind, parent: Context, attrs: Record<string, string>, fn: (span: Span) => Promise<T>) {
  return tracer.startActiveSpan(name, { kind, attributes: attrs }, parent, async (span) => {
    try {
      return await fn(span);
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      span.end();
    }
  });
}

export const contextFrom = (carrier: Carrier) => propagation.extract(ROOT_CONTEXT, carrier);

/** The active span as a traceparent string, to store with a job (undefined when not tracing). */
export function currentTraceparent(): string | undefined {
  const out: Record<string, string> = {};
  propagation.inject(context.active(), out);
  return out.traceparent;
}

/** Adds traceparent (and tracestate) for the active span to outgoing request headers. */
export function injectTrace(headers: Record<string, string>) {
  propagation.inject(context.active(), headers);
  return headers;
}

export { SpanKind };
