// Load before the app: node --import ./dist/otel.js dist/api/server.js
// Does nothing unless OTEL_EXPORTER_OTLP_ENDPOINT is set (e.g. http://jaeger:4318).
import { register } from "node:module";

if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  // ESM: auto-instrumentation patches modules through this loader hook, so it must be registered first.
  register("@opentelemetry/instrumentation/hook.mjs", import.meta.url);

  const [{ NodeSDK }, { OTLPTraceExporter }, { HttpInstrumentation }, { UndiciInstrumentation }, { IORedisInstrumentation }, { PrismaInstrumentation }] =
    await Promise.all([
      import("@opentelemetry/sdk-node"),
      import("@opentelemetry/exporter-trace-otlp-http"),
      import("@opentelemetry/instrumentation-http"),
      import("@opentelemetry/instrumentation-undici"),
      import("@opentelemetry/instrumentation-ioredis"),
      import("@prisma/instrumentation"),
    ]);

  const sdk = new NodeSDK({
    serviceName: process.env.OTEL_SERVICE_NAME ?? "relayq",
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [
      // Health checks and scrapes would drown the useful traces.
      new HttpInstrumentation({ ignoreIncomingRequestHook: (req) => /^\/(health|metrics)/.test(req.url ?? "") }),
      new UndiciInstrumentation(), // fetch: webhooks, callbacks
      // BullMQ polls Redis constantly; only keep Redis spans that sit under a real request or job.
      new IORedisInstrumentation({ requireParentSpan: true }),
      new PrismaInstrumentation(),
    ],
  });
  sdk.start();
  process.once("beforeExit", () => void sdk.shutdown());
}
