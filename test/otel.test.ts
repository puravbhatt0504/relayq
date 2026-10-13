import { context, propagation, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { webhookDeliver } from "../src/worker/handlers/webhook.deliver.js";
import { startWorkers } from "../src/worker/index.js";
import { KEY_A, startEnv, waitFor } from "./env.js";

const exporter = new InMemorySpanExporter();
let env: Awaited<ReturnType<typeof startEnv>>;
let workers: ReturnType<typeof startWorkers>;
let sink: Server;
const received: string[] = [];

beforeAll(async () => {
  trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }));
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  process.env.WEBHOOK_SECRET = "s";

  sink = createServer((req, res) => {
    received.push(String(req.headers.traceparent));
    req.resume().on("end", () => res.end("ok"));
  }).listen(0);
  env = await startEnv();
  workers = startWorkers({
    connection: env.connection, prisma: env.prisma, dead: env.queues.dead,
    handlers: { "email.digest": async () => ({}), "board.export": async () => ({}), "webhook.deliver": webhookDeliver },
  });
});
afterAll(async () => { await workers?.close(); await env?.stop(); sink?.close(); });

describe("trace propagation", () => {
  it("job enqueued with traceparent → enqueue and worker spans share its trace id; webhook carries it on", async () => {
    const T = "4bf92f3577b34da6a3ce929d0e0e4736";
    const res = await env.app.inject({
      method: "POST", url: "/jobs",
      headers: { authorization: `Bearer ${KEY_A}`, traceparent: `00-${T}-00f067aa0ba902b7-01` },
      payload: { type: "webhook.deliver", payload: { url: `http://127.0.0.1:${(sink.address() as AddressInfo).port}/`, body: {} } },
    });
    expect(res.statusCode).toBe(202);
    const { jobId } = res.json();
    await waitFor(async () => (await env.prisma.jobRecord.findUniqueOrThrow({ where: { id: jobId } })).status === "completed");

    const spans = exporter.getFinishedSpans();
    const enqueue = spans.find((s) => s.name === "enqueue webhook.deliver")!;
    const work = spans.find((s) => s.name === "process webhook.deliver")!;
    expect(enqueue.spanContext().traceId).toBe(T);
    expect(enqueue.parentSpanContext?.spanId).toBe("00f067aa0ba902b7"); // child of the caller's span
    expect(work.spanContext().traceId).toBe(T);
    expect(work.parentSpanContext?.spanId).toBe(enqueue.spanContext().spanId); // worker continues the enqueue span
    expect(work.attributes["relayq.job_id"]).toBe(jobId);

    expect(received).toHaveLength(1);
    expect(received[0]).toMatch(new RegExp(`^00-${T}-${work.spanContext().spanId}-01$`)); // receiver joins the same trace
  });

  it("job without traceparent still gets a (new) trace on both sides", async () => {
    exporter.reset();
    const { jobId } = (await env.post({ type: "webhook.deliver", payload: { url: `http://127.0.0.1:${(sink.address() as AddressInfo).port}/`, body: {} } })).json();
    await waitFor(async () => (await env.prisma.jobRecord.findUniqueOrThrow({ where: { id: jobId } })).status === "completed");
    const spans = exporter.getFinishedSpans();
    const enqueue = spans.find((s) => s.name === "enqueue webhook.deliver")!;
    const work = spans.find((s) => s.name === "process webhook.deliver")!;
    expect(work.spanContext().traceId).toBe(enqueue.spanContext().traceId);
  });
});
