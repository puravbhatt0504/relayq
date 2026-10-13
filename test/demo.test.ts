import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/api/server.js";
import { webhookDeliver } from "../src/worker/handlers/webhook.deliver.js";
import { startWorkers } from "../src/worker/index.js";
import { startEnv, waitFor } from "./env.js";

let env: Awaited<ReturnType<typeof startEnv>>;
let demo: ReturnType<typeof buildApp>;
let workers: ReturnType<typeof startWorkers>;

beforeAll(async () => {
  process.env.WEBHOOK_SECRET = "demo-secret";
  env = await startEnv({ jobOptions: { attempts: 5, backoff: { type: "exponential", delay: 20 }, removeOnComplete: 1000, removeOnFail: false } });
  demo = buildApp({ prisma: env.prisma, redis: env.redis, queues: env.queues }, { demo: true });
  await demo.listen({ port: 0, host: "127.0.0.1" });
  process.env.DEMO_SINK_URL = `http://127.0.0.1:${(demo.server.address() as AddressInfo).port}/demo/sink`;
  workers = startWorkers({
    connection: env.connection, prisma: env.prisma, dead: env.queues.dead,
    handlers: { "email.digest": async () => ({}), "board.export": async () => ({}), "webhook.deliver": webhookDeliver },
    tenantLimit: { max: 1000, windowMs: 60_000 },
  });
});
afterAll(async () => { await workers?.close(); await demo?.close(); await env?.stop(); });

describe("public demo", () => {
  it("page is public; API routes still need a key", async () => {
    expect((await demo.inject({ url: "/demo" })).body).toContain("Run 100 jobs");
    expect((await demo.inject({ method: "POST", url: "/jobs", payload: {} })).statusCode).toBe(401);
  });

  it("serves scene assets, and nothing outside the assets folder", async () => {
    const glb = await demo.inject({ url: "/demo/assets/Soldier.glb" });
    expect(glb.statusCode).toBe(200);
    expect(glb.headers["content-type"]).toBe("model/gltf-binary");
    expect((await demo.inject({ url: "/demo/assets/hill.js" })).headers["content-type"]).toContain("text/javascript");
    expect((await demo.inject({ url: "/demo/assets/%2e%2e%2f%2e%2e%2f%2e%2e%2fpackage.json" })).statusCode).toBe(404);
    expect((await demo.inject({ url: "/demo/assets/..%5c..%5c..%5csrc%5capi%5cdemo.ts" })).statusCode).toBe(404);
    expect((await demo.inject({ url: "/demo/assets/missing.glb" })).statusCode).toBe(404);
  });

  it("run enqueues 100 jobs to the built-in sink; flaky ones retry once; cooldown enforced", async () => {
    expect((await demo.inject({ method: "POST", url: "/demo/run" })).statusCode).toBe(202);
    expect((await demo.inject({ method: "POST", url: "/demo/run" })).statusCode).toBe(429);

    const stats = await waitFor(async () => {
      const s = (await demo.inject({ url: "/demo/stats" })).json();
      return s.jobs.completed === 100 && s;
    });
    expect(stats.sink).toEqual({ deliveries: 120, distinctKeys: 100 });
    expect(await env.prisma.jobRecord.count({ where: { tenant: "demo", attempts: 2 } })).toBe(20);
    expect(stats.recent).toHaveLength(8);
  });
});
