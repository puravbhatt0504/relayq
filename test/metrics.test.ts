import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startWorkers } from "../src/worker/index.js";
import { startEnv, waitFor } from "./env.js";

let env: Awaited<ReturnType<typeof startEnv>>;
let workers: ReturnType<typeof startWorkers>;

beforeAll(async () => {
  process.env.ADMIN_USER = "admin";
  process.env.ADMIN_PASSWORD = "pw";
  env = await startEnv();
  workers = startWorkers({
    connection: env.connection,
    prisma: env.prisma,
    dead: env.queues.dead,
    handlers: { "email.digest": async () => ({}), "board.export": async () => ({}), "webhook.deliver": async () => ({ status: 200 }) },
  });
});
afterAll(async () => { await workers?.close(); await env?.stop(); });

const basic = (u: string, p: string) => ({ authorization: `Basic ${Buffer.from(`${u}:${p}`).toString("base64")}` });

describe("/metrics", () => {
  it("counts 10 completed webhook jobs, exposes duration and queue depth", async () => {
    const hook = { type: "webhook.deliver", payload: { url: "https://example.com/h", body: null } };
    for (let i = 0; i < 10; i++) await env.post(hook);
    await waitFor(async () => (await env.prisma.jobRecord.count({ where: { status: "completed" } })) === 10);

    const res = await env.app.inject({ url: "/metrics" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('relayq_jobs_total{type="webhook.deliver",status="completed"} 10');
    expect(res.body).toContain('relayq_job_duration_seconds_count{type="webhook.deliver"} 10');
    expect(res.body).toContain('relayq_queue_depth{queue="webhook.deliver"} 0');
  });
});

describe("/admin/queues", () => {
  it("401 without or with wrong basic auth, 200 with it", async () => {
    const none = await env.app.inject({ url: "/admin/queues" });
    expect(none.statusCode).toBe(401);
    expect(none.headers["www-authenticate"]).toContain("Basic");
    expect((await env.app.inject({ url: "/admin/queues", headers: basic("admin", "nope") })).statusCode).toBe(401);
    expect((await env.app.inject({ url: "/admin/queues/api/queues", headers: { authorization: "Bearer rq_tenantA_secret" } })).statusCode).toBe(401);
    const ok = await env.app.inject({ url: "/admin/queues", headers: basic("admin", "pw") });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toContain("<html");
  });
});

describe("/health", () => {
  it("200 {redis:ok, db:ok}", async () => {
    const res = await env.app.inject({ url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ redis: "ok", db: "ok" });
  });
});
