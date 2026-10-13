import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isBlockedIp } from "../src/lib/ssrf.js";
import { webhookDeliver } from "../src/worker/handlers/webhook.deliver.js";
import { startWorkers } from "../src/worker/index.js";
import { startEnv, waitFor } from "./env.js";

it.each([
  "127.0.0.1", "10.0.0.1", "172.16.5.4", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
  "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:a9fe:a9fe",
])("isBlockedIp(%s) → true", (ip) => expect(isBlockedIp(ip)).toBe(true));
it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])("isBlockedIp(%s) → false", (ip) => expect(isBlockedIp(ip)).toBe(false));

// Sink on localhost: counts requests per path; /redirect answers 302 to the metadata address.
const hits: string[] = [];
let sink: Server;
let env: Awaited<ReturnType<typeof startEnv>>;
let workers: ReturnType<typeof startWorkers>;
const sinkUrl = (path: string) => `http://localhost:${(sink.address() as AddressInfo).port}${path}`;

beforeAll(async () => {
  sink = createServer((req, res) => {
    hits.push(req.url!);
    if (req.url === "/redirect") return res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }).end();
    res.end("ok");
  }).listen(0);
  process.env.WEBHOOK_SECRET = "s";
  env = await startEnv({ jobOptions: { attempts: 2, backoff: { type: "fixed", delay: 100 }, removeOnComplete: 1000, removeOnFail: false } });
  workers = startWorkers({
    connection: env.connection, prisma: env.prisma, dead: env.queues.dead,
    handlers: { "webhook.deliver": webhookDeliver }, tenantLimit: { max: 100_000, windowMs: 60_000 },
  });
});
afterAll(async () => { await workers?.close(); await env?.stop(); sink?.close(); });

async function deliver(url: string) {
  const { jobId } = (await env.post({ type: "webhook.deliver", payload: { url, body: { x: 1 } } })).json() as { jobId: string };
  return waitFor(async () => {
    const j = (await env.get(`/jobs/${jobId}`)).json() as { status: string; attempts: number; error?: string };
    return ["completed", "dead"].includes(j.status) || (j.status === "failed" && j.error?.startsWith("blocked_url")) ? j : null;
  });
}
async function withAllow<T>(allow: string, fn: () => Promise<T>) {
  const saved = process.env.OUTBOUND_ALLOW;
  process.env.OUTBOUND_ALLOW = allow;
  try { return await fn(); } finally { process.env.OUTBOUND_ALLOW = saved; }
}

describe("SSRF guard on outbound calls", () => {
  it("cloud metadata address → failed blocked_url after 1 attempt", async () => {
    const j = await deliver("http://169.254.169.254/latest/meta-data/");
    expect(j).toMatchObject({ status: "failed", attempts: 1 });
    expect(j.error).toMatch(/^blocked_url/);
  });

  it("localhost not on OUTBOUND_ALLOW → blocked at DNS, sink never hit", async () => {
    const j = await withAllow("", () => deliver(sinkUrl("/private")));
    expect(j.status).toBe("failed");
    expect(j.error).toMatch(/^blocked_url: localhost resolves to blocked address/);
    expect(hits).not.toContain("/private");
  });

  it("localhost on OUTBOUND_ALLOW → delivered", async () => {
    const j = await withAllow("localhost", () => deliver(sinkUrl("/allowed")));
    expect(j.status).toBe("completed");
    expect(hits).toContain("/allowed");
  });

  it("302 to the metadata address is not followed: job retries, then dead", async () => {
    const j = await withAllow("localhost", () => deliver(sinkUrl("/redirect")));
    expect(j).toMatchObject({ status: "dead", attempts: 2 });
    expect(j.error).toMatch(/→ 302$/);
    expect(hits.filter((h) => h === "/redirect")).toHaveLength(2);
    expect(hits.some((h) => h.startsWith("/latest"))).toBe(false);
  });

  it("non-http scheme → blocked_url", async () => {
    const j = await deliver("ftp://example.com/x");
    expect(j.status).toBe("failed");
    expect(j.error).toBe("blocked_url: scheme ftp:");
  });
});
