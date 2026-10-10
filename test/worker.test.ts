import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { defaultJobOptions } from "../src/queue/queues.js";
import { sign, webhookDeliver } from "../src/worker/handlers/webhook.deliver.js";
import { onSigterm, startWorkers } from "../src/worker/index.js";
import { KEY_B, startEnv, waitFor } from "./env.js";

let env: Awaited<ReturnType<typeof startEnv>>;
let workers: ReturnType<typeof startWorkers>;
let impl: () => Promise<unknown>;
const calls = vi.fn();
const digest = { type: "email.digest", payload: { to: "a@b.co", userName: "Ann", items: [] } };

beforeAll(async () => {
  // Same 5 attempts as prod; backoff base shrunk from 2s so the suite runs in seconds.
  env = await startEnv({ jobOptions: { ...defaultJobOptions, backoff: { type: "exponential", delay: 20 } } });
  workers = startWorkers({
    connection: env.connection,
    prisma: env.prisma,
    dead: env.queues.dead,
    handlers: {
      "email.digest": async () => { calls(); return impl(); },
      "board.export": async () => { throw new Error("unused"); },
      "webhook.deliver": webhookDeliver,
    },
  });
});
afterAll(async () => { await workers?.close(); await env?.stop(); });

const record = (id: string) => env.prisma.jobRecord.findUniqueOrThrow({ where: { id } });
const settled = (id: string, status: string) =>
  waitFor(async () => { const r = await record(id); return r.status === status && r; });

describe("retries and dead letters", () => {
  it("always-throwing handler ends dead after exactly 5 attempts; retry re-queues it", async () => {
    calls.mockClear();
    impl = async () => { throw new Error("boom"); };
    const { jobId } = (await env.post(digest)).json();
    expect(await settled(jobId, "dead")).toMatchObject({ attempts: 5, error: "boom" });
    expect(calls).toHaveBeenCalledTimes(5);
    expect(await env.queues.dead.getJob(jobId)).toBeTruthy();

    expect((await env.retry(jobId, KEY_B)).statusCode).toBe(404);
    impl = async () => ({ ok: true });
    expect((await env.retry(jobId)).statusCode).toBe(202);
    expect(await settled(jobId, "completed")).toMatchObject({ attempts: 1, error: null, result: { ok: true } });
    expect(await env.queues.dead.getJob(jobId)).toBeFalsy();
  });

  it("fails twice then succeeds → completed with attempts = 3", async () => {
    let n = 0;
    impl = async () => { if (++n <= 2) throw new Error(`fail ${n}`); return { n }; };
    const { jobId } = (await env.post(digest)).json();
    expect(await settled(jobId, "completed")).toMatchObject({ attempts: 3, result: { n: 3 } });
  });

  it("retry on a non-dead job → 409", async () => {
    impl = async () => ({});
    const { jobId } = (await env.post(digest)).json();
    await settled(jobId, "completed");
    expect((await env.retry(jobId)).statusCode).toBe(409);
  });
});

describe("webhook.deliver", () => {
  let server: Server;
  afterAll(() => { server?.close(); });

  it("signature verifies with the shared secret; non-2xx is retried", async () => {
    process.env.WEBHOOK_SECRET = "shared-s3cret";
    const hits: { raw: string; sig: string }[] = [];
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c)).on("end", () => {
        hits.push({ raw, sig: String(req.headers["x-relayq-signature"]) });
        res.statusCode = hits.length === 1 ? 500 : 200; // first delivery fails
        res.end();
      });
    }).listen(0);
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
    const { jobId } = (await env.post({ type: "webhook.deliver", payload: { url, body: { event: "card.moved" } } })).json();

    expect(await settled(jobId, "completed")).toMatchObject({ attempts: 2, result: { status: 200 } });
    expect(hits).toHaveLength(2);
    expect(JSON.parse(hits[1].raw)).toEqual({ event: "card.moved" });
    expect(hits[1].sig).toBe(sign(hits[1].raw, "shared-s3cret"));
    expect(hits[1].sig).not.toBe(sign(hits[1].raw, "wrong-secret"));
  });
});

// Last: it shuts the workers down.
describe("graceful shutdown", () => {
  it("SIGTERM during an active job lets it complete, then exits 0 and takes no new jobs", async () => {
    impl = () => new Promise((r) => setTimeout(() => r({ slow: true }), 1500));
    const { jobId } = (await env.post(digest)).json();
    await settled(jobId, "active");

    const exit = vi.fn();
    onSigterm(workers.close, exit);
    process.emit("SIGTERM");

    await waitFor(async () => exit.mock.calls.length > 0);
    expect(exit).toHaveBeenCalledWith(0);
    expect(await record(jobId)).toMatchObject({ status: "completed", result: { slow: true } });

    const { jobId: late } = (await env.post(digest)).json();
    await new Promise((r) => setTimeout(r, 500));
    expect((await record(late)).status).toBe("queued");
  });
});
