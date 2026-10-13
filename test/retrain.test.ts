import { Prisma } from "@prisma/client";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { once } from "../src/lib/effects.js";
import { mlRetrain, type Trainer } from "../src/worker/handlers/ml.retrain.js";
import { startWorkers } from "../src/worker/index.js";
import { startEnv, waitFor } from "./env.js";

// Stub trainer: test MAE comes from the data URL (?mae=8); ?crash=<id> crashes the first run for that id.
const crashed = new Set<string>();
const trainer: Trainer = async (_name, dataUrl) => {
  const q = new URL(dataUrl).searchParams;
  const crash = q.get("crash");
  if (crash && !crashed.has(crash)) { crashed.add(crash); throw new Error("trainer exited 137"); }
  return { s3Uri: `s3://models/eta/${q.get("mae")}/`, metrics: { mae: Number(q.get("mae")), rmse: 1 } };
};

const notified: { key: string; body: { name: string; version: number } }[] = [];
let subscriber: Server;
const readJson = <T>(req: IncomingMessage) =>
  new Promise<T>((r) => { let b = ""; req.on("data", (c) => (b += c)).on("end", () => r(JSON.parse(b))); });

let env: Awaited<ReturnType<typeof startEnv>>;
let workers: ReturnType<typeof startWorkers>;

beforeAll(async () => {
  subscriber = createServer(async (req, res) => {
    notified.push({ key: String(req.headers["idempotency-key"]), body: await readJson(req) });
    res.end("ok");
  }).listen(0);
  Object.assign(process.env, {
    WEBHOOK_SECRET: "s",
    MODEL_SUBSCRIBERS_ETA: `http://127.0.0.1:${(subscriber.address() as AddressInfo).port}/reload`,
  });
  env = await startEnv();
  workers = startWorkers({
    connection: env.connection, prisma: env.prisma, dead: env.queues.dead,
    handlers: { "ml.retrain": mlRetrain(trainer) }, tenantLimit: { max: 100_000, windowMs: 60_000 },
  });
});
afterAll(async () => { await workers?.close(); await env?.stop(); subscriber?.close(); });

async function retrain(query: string) {
  const res = await env.post({ type: "ml.retrain", payload: { modelName: "eta", dataUrl: `https://data.example/eta.parquet?${query}` } });
  expect(res.statusCode).toBe(202);
  const { jobId } = res.json() as { jobId: string };
  return waitFor(async () => {
    const j = (await env.get(`/jobs/${jobId}`)).json() as { id: string; status: string; attempts: number; result?: Record<string, unknown> };
    return ["completed", "dead"].includes(j.status) && j; // "failed" = attempt failed, retry pending
  }, 30_000);
}
const promoted = () => env.prisma.modelVersion.findMany({ where: { name: "eta", status: "promoted" } });

describe("ml.retrain + model registry", () => {
  it("first model → promoted v1, subscriber notified once", async () => {
    const j = await retrain("mae=10");
    expect(j.result).toMatchObject({ version: 1, status: "promoted" });
    expect(notified.map((n) => n.body)).toEqual([{ name: "eta", version: 1 }]);
  });

  it("better MAE → promoted, old version retired, subscriber notified once", async () => {
    const j = await retrain("mae=8");
    expect(j.result).toMatchObject({ version: 2, status: "promoted" });
    expect((await promoted()).map((v) => v.version)).toEqual([2]);
    expect(await env.prisma.modelVersion.findFirst({ where: { name: "eta", version: 1 } })).toMatchObject({ status: "retired" });
    expect(notified.filter((n) => n.body.version === 2)).toHaveLength(1);
  });

  it("worse MAE → rejected with reason, promoted version unchanged, nobody notified", async () => {
    const before = notified.length;
    const j = await retrain("mae=9");
    expect(j.result).toMatchObject({ version: 3, status: "rejected", reason: "test MAE 9 > promoted v2 MAE 8" });
    expect((await promoted()).map((v) => v.version)).toEqual([2]);
    expect(notified).toHaveLength(before);
  });

  it("trainer crash → job retried, then promoted; never two promoted rows", async () => {
    const j = await retrain("mae=7&crash=a");
    expect(j.status).toBe("completed");
    expect(j.attempts).toBe(2);
    expect(j.result).toMatchObject({ version: 4, status: "promoted" });
    expect((await promoted()).map((v) => v.version)).toEqual([4]);
  });

  it("re-delivery of a finished retrain registers nothing new and notifies nobody again", async () => {
    const rows = await env.prisma.modelVersion.count();
    const before = notified.length;
    const run = () => mlRetrain(trainer)({ modelName: "eta", dataUrl: "https://data.example/x?mae=1" }, {
      jobId: "redelivered", tenant: "A", prisma: env.prisma, redis: env.redis,
      once: (step, fn) => once(env.prisma, "redelivered", step, fn),
    });
    const [a, b] = [await run(), await run()];
    expect(b).toEqual(a);
    expect(await env.prisma.modelVersion.count()).toBe(rows + 1);
    expect(notified).toHaveLength(before + 1);
  });

  it("database refuses a second promoted row for the same name (partial unique index)", async () => {
    const insert = env.prisma.modelVersion.create({
      data: { name: "eta", version: 99, s3Uri: "s3://x", metrics: { mae: 0 }, status: "promoted", jobId: "manual" },
    });
    await expect(insert).rejects.toSatisfy((e) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002");
  });

  it("GET /models/:name → promoted version + metric history; unknown → 404", async () => {
    const res = await env.get("/models/eta");
    expect(res.statusCode).toBe(200);
    const body = res.json() as { promoted: { version: number; metrics: { mae: number } }; history: { version: number; status: string }[] };
    expect(body.promoted).toMatchObject({ version: 5, metrics: { mae: 1 } });
    expect(body.history.map((h) => [h.version, h.status])).toEqual([
      [5, "promoted"], [4, "retired"], [3, "rejected"], [2, "retired"], [1, "retired"],
    ]);
    expect((await env.get("/models/nope")).statusCode).toBe(404);
  });
});
