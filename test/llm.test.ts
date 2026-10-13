import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { costUsd } from "../src/llm/prices.js";
import { startWorkers } from "../src/worker/index.js";
import { KEY_B, startEnv, waitFor } from "./env.js";

// Mock Anthropic API. Each test steers it through the user message, a JSON directive:
// { in: input tokens count_tokens reports, usage?: what /v1/messages bills, overload?: primary answers 529 }
type Directive = { in: number; usage?: [number, number, number, number]; overload?: boolean };
const calls: { t: number; model: string; tokens: number; tag: string }[] = [];
const port = (s: Server) => (s.address() as AddressInfo).port;
const readJson = <T>(req: IncomingMessage) =>
  new Promise<T>((r) => { let b = ""; req.on("data", (c) => (b += c)).on("end", () => r(JSON.parse(b))); });
type Body = { model: string; max_tokens: number; messages: { content: string }[] };
const directive = (b: Body) => JSON.parse(b.messages[0].content) as Directive & { tag: string };

let provider: Server;
const callbacks = new Map<string, Record<string, unknown>>();
let sink: Server;
let env: Awaited<ReturnType<typeof startEnv>>;
let workers: ReturnType<typeof startWorkers>;

beforeAll(async () => {
  provider = createServer(async (req, res) => {
    const body = await readJson<Body>(req);
    const d = directive(body);
    const json = (status: number, v: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(v));
    if (req.url?.startsWith("/v1/messages/count_tokens")) return json(200, { input_tokens: d.in });
    calls.push({ t: Date.now(), model: body.model, tokens: d.in + body.max_tokens, tag: d.tag });
    if (d.overload && body.model === "claude-sonnet-5-5")
      return json(529, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } });
    const [input, output, cacheWrite, cacheRead] = d.usage ?? [d.in, 10, 0, 0];
    json(200, {
      id: "msg_1", type: "message", role: "assistant", model: body.model, stop_reason: "end_turn", stop_sequence: null,
      content: [{ type: "text", text: "ok" }],
      usage: { input_tokens: input, output_tokens: output, cache_creation_input_tokens: cacheWrite, cache_read_input_tokens: cacheRead },
    });
  }).listen(0);
  sink = createServer(async (req, res) => {
    callbacks.set(String(req.headers["idempotency-key"]), await readJson(req));
    res.end("ok");
  }).listen(0);
  Object.assign(process.env, {
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port(provider)}`, ANTHROPIC_API_KEY: "test", WEBHOOK_SECRET: "s",
    LLM_TPM: "6000", LLM_TPM_WINDOW_MS: "2000",
  });

  env = await startEnv();
  await env.prisma.tenantBudget.createMany({ data: [{ tenant: "A", monthlyUsdLimit: 1000 }, { tenant: "B", monthlyUsdLimit: 1 }] });
  workers = startWorkers({
    connection: env.connection, prisma: env.prisma, dead: env.queues.dead,
    concurrency: 20, tenantLimit: { max: 100_000, windowMs: 60_000 },
  });
});
afterAll(async () => { await workers?.close(); await env?.stop(); provider?.close(); sink?.close(); });

const job = (d: Directive & { tag: string }, extra: Record<string, unknown> = {}) => ({
  type: "llm.complete",
  payload: {
    model: "claude-sonnet-5-5", maxTokens: 500,
    messages: [{ role: "user", content: JSON.stringify(d) }],
    callbackUrl: `http://127.0.0.1:${port(sink)}/llm`, ...extra,
  },
});
async function run(body: unknown, key?: string) {
  const res = await env.post(body, key);
  expect(res.statusCode).toBe(202);
  const { jobId } = res.json() as { jobId: string };
  return waitFor(async () => {
    const j = (await env.get(`/jobs/${jobId}`, key)).json() as { id: string; status: string; error?: string; result?: Record<string, unknown> };
    return ["completed", "failed", "dead"].includes(j.status) && j;
  });
}

describe("llm.complete", () => {
  it("$0.01 left, job estimated at $0.02 → budget_exceeded, no provider call, tenant webhook", async () => {
    // Tenant B: $1 limit, $0.99 already committed this month.
    await env.redis.set(`llm:budget:B:${new Date().toISOString().slice(0, 7)}`, 990_000);
    // sonnet: 1000 in × $2/M + 1800 out × $10/M = $0.02
    const j = await run(job({ in: 1000, tag: "budget" }, { maxTokens: 1800 }), KEY_B);
    expect(j.status).toBe("failed");
    expect(j.error).toBe("budget_exceeded");
    expect(calls.filter((c) => c.tag === "budget")).toHaveLength(0);
    expect(callbacks.get(`${j.id}:budget-webhook`)).toMatchObject({ jobId: j.id, error: "budget_exceeded", estimatedUsd: 0.02 });
  });

  it("two overloaded responses → completes on the fallback with modelUsed = fallback", async () => {
    const j = await run(job({ in: 100, overload: true, tag: "fallback" }, { fallbackModel: "claude-haiku-5-5" }));
    expect(j.status).toBe("completed");
    expect(j.result?.modelUsed).toBe("claude-haiku-5-5");
    expect(calls.filter((c) => c.tag === "fallback").map((c) => c.model)).toEqual(["claude-sonnet-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);
    expect(callbacks.get(`${j.id}:callback`)).toMatchObject({ modelUsed: "claude-haiku-5-5" });
    // Billed at the fallback's price, not the primary's.
    const row = await env.prisma.llmUsage.findFirstOrThrow({ where: { jobId: j.id } });
    expect(row.model).toBe("claude-haiku-5-5");
    expect(Number(row.costUsd)).toBe(costUsd("claude-haiku-5-5", { inputTokens: 100, outputTokens: 10 }));
  });

  it("ledger cost = prices.ts × tokens, to the cent (and exactly)", async () => {
    const j = await run(job({ in: 1234, usage: [1234, 567, 2000, 3000], tag: "ledger" }));
    expect(j.status).toBe("completed");
    const row = await env.prisma.llmUsage.findFirstOrThrow({ where: { jobId: j.id } });
    const expected = costUsd("claude-sonnet-5-5", { inputTokens: 1234, outputTokens: 567, cacheWriteTokens: 2000, cacheReadTokens: 3000 });
    expect(expected).toBe(0.013738); // 1234×2 + 567×10 + 2000×2.5 + 3000×0.2 micro-dollars
    expect(Number(row.costUsd)).toBe(expected);
    expect(row).toMatchObject({ model: "claude-sonnet-5-5", inputTokens: 1234, outputTokens: 567, cacheWriteTokens: 2000, cacheReadTokens: 3000 });
  });

  it("20 concurrent jobs never exceed the TPM limit", async () => {
    await env.redis.del("llm:tpm:anthropic"); // full bucket
    // Bucket 6000 tokens, refills 3 tokens/ms; each job needs 500 in + 500 max out = 1000.
    const jobs = await Promise.all(Array.from({ length: 20 }, () => run(job({ in: 500, tag: "tpm" }))));
    expect(jobs.every((j) => j.status === "completed")).toBe(true);

    const ts = calls.filter((c) => c.tag === "tpm").sort((a, b) => a.t - b.t);
    expect(ts).toHaveLength(20);
    // Token bucket bound: tokens sent in any [ti, tj] ≤ capacity + rate × (tj − ti). Slack: one job for take→call latency.
    for (let i = 0; i < ts.length; i++) {
      let sum = 0;
      for (let j = i; j < ts.length; j++) {
        sum += ts[j].tokens;
        expect(sum).toBeLessThanOrEqual(6000 + 3 * (ts[j].t - ts[i].t) + 1000);
      }
    }
    expect(ts[19].t - ts[0].t).toBeGreaterThanOrEqual(4000); // (20,000 − 6,000) / 3 per ms ≈ 4.7 s
  }, 60_000);
});
