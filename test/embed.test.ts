import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startWorkers } from "../src/worker/index.js";
import { startEnv, waitFor } from "./env.js";

// Mock Voyage: embedding[0] encodes the text's number so the test can check each job got its own vectors.
const calls: { t: number; n: number }[] = [];
let rateLimitNext = false;
let provider: Server;
// Callback sink: one entry per delivered result.
const delivered = new Map<string, { id: string; embedding: number[] }[]>();
let sink: Server;

const port = (s: Server) => (s.address() as AddressInfo).port;
const readJson = (req: import("node:http").IncomingMessage) =>
  new Promise<any>((r) => { let b = ""; req.on("data", (c) => (b += c)).on("end", () => r(JSON.parse(b))); });

let env: Awaited<ReturnType<typeof startEnv>>;
let workers: ReturnType<typeof startWorkers>;

beforeAll(async () => {
  provider = createServer(async (req, res) => {
    const { input } = await readJson(req);
    calls.push({ t: Date.now(), n: input.length });
    if (rateLimitNext) {
      rateLimitNext = false;
      res.writeHead(429, { "retry-after": "2" }).end("slow down");
      return;
    }
    const data = input.map((text: string, index: number) => ({ index, embedding: [Number(text.slice(1)), ...Array(1023).fill(0)] }));
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data }));
  }).listen(0);
  sink = createServer(async (req, res) => {
    delivered.set(String(req.headers["idempotency-key"]), (await readJson(req)).items);
    res.end("ok");
  }).listen(0);
  process.env.VOYAGE_BASE_URL = `http://127.0.0.1:${port(provider)}`;
  process.env.VOYAGE_API_KEY = "test";
  process.env.WEBHOOK_SECRET = "s";

  env = await startEnv();
  workers = startWorkers({ connection: env.connection, prisma: env.prisma, dead: env.queues.dead, tenantLimit: { max: 100_000, windowMs: 60_000 } });
});
afterAll(async () => { await workers?.close(); await env?.stop(); provider?.close(); sink?.close(); });

const job = (items: { id: string; text: string }[]) =>
  ({ type: "embed.batch", payload: { items, callbackUrl: `http://127.0.0.1:${port(sink)}/embeddings` } });

describe("embed.batch", () => {
  it("300 single-item jobs enqueued together → ≤ 4 provider calls and 300 correct callbacks", async () => {
    const res = await Promise.all(Array.from({ length: 300 }, (_, i) => env.post(job([{ id: `doc-${i}`, text: `t${i}` }]))));
    expect(res.every((r) => r.statusCode === 202)).toBe(true);
    await waitFor(async () => delivered.size === 300, 30_000);

    expect(calls.length).toBeLessThanOrEqual(4);
    expect(calls.reduce((n, c) => n + c.n, 0)).toBe(300);
    for (const items of delivered.values()) {
      expect(items).toHaveLength(1);
      expect(items[0].embedding).toHaveLength(1024);
      expect(items[0].embedding[0]).toBe(Number(items[0].id.slice(4))); // doc-17 got t17's vector
    }
  }, 60_000);

  it("provider 429 with Retry-After: 2 → delayed ~2 s, attempts unchanged", async () => {
    calls.length = 0;
    rateLimitNext = true;
    const { jobId } = (await env.post(job([{ id: "late", text: "t7" }]))).json();
    await waitFor(async () => delivered.has(`${jobId}:callback`), 15_000);

    expect(calls).toHaveLength(2);
    const gap = calls[1].t - calls[0].t;
    expect(gap).toBeGreaterThanOrEqual(1900);
    expect(gap).toBeLessThan(4000);
    expect(await env.prisma.jobRecord.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ status: "completed", attempts: 1 });
  });

  it("129 items → 400", async () => {
    const items = Array.from({ length: 129 }, (_, i) => ({ id: `x${i}`, text: `t${i}` }));
    const res = await env.post(job(items));
    expect(res.statusCode).toBe(400);
    expect(res.json().errors[0].path).toEqual(["items"]);
  });
});
