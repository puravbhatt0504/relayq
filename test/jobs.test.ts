import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import { PrismaClient } from "@prisma/client";
import { Redis } from "ioredis";
import { execSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashKey } from "../src/api/auth.js";
import { buildApp } from "../src/api/server.js";
import { createQueues, type Queues } from "../src/queue/queues.js";

const KEY_A = "rq_tenantA_secret";
const KEY_B = "rq_tenantB_secret";
const webhook = { type: "webhook.deliver", payload: { url: "https://example.com/hook", body: { hi: 1 } } };

let pg: StartedPostgreSqlContainer, rc: StartedRedisContainer;
let prisma: PrismaClient, redis: Redis, queues: Queues, app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  [pg, rc] = await Promise.all([new PostgreSqlContainer("postgres:16-alpine").start(), new RedisContainer("redis:7-alpine").start()]);
  const url = pg.getConnectionUri();
  execSync("npx prisma db push --skip-generate", { env: { ...process.env, DATABASE_URL: url }, stdio: "inherit" });
  prisma = new PrismaClient({ datasourceUrl: url });
  await prisma.apiKey.createMany({ data: [{ hash: hashKey(KEY_A), tenant: "A" }, { hash: hashKey(KEY_B), tenant: "B" }] });
  redis = new Redis(rc.getConnectionUrl());
  queues = createQueues(new Redis(rc.getConnectionUrl(), { maxRetriesPerRequest: null }));
  app = buildApp({ prisma, redis, queues });
}, 120_000);

afterAll(async () => {
  await app?.close();
  await Promise.all(Object.values(queues ?? {}).map((q) => q.close()));
  redis?.disconnect();
  await prisma?.$disconnect();
  await Promise.all([pg?.stop(), rc?.stop()]);
});

const post = (body: unknown, key = KEY_A) =>
  app.inject({ method: "POST", url: "/jobs", headers: { authorization: `Bearer ${key}` }, payload: body as object });

describe("POST /jobs", () => {
  it("202 on valid job, and writes JobRecord", async () => {
    const res = await post(webhook);
    expect(res.statusCode).toBe(202);
    const { jobId, status } = res.json();
    expect(status).toBe("queued");
    expect(await prisma.jobRecord.findUnique({ where: { id: jobId } })).toMatchObject({ tenant: "A", status: "queued" });
  });

  it("400 on unknown type", async () => {
    expect((await post({ type: "nope", payload: {} })).statusCode).toBe(400);
  });

  it("400 {errors} on bad payload", async () => {
    const res = await post({ type: "email.digest", payload: { to: "not-an-email", userName: "x", items: [] } });
    expect(res.statusCode).toBe(400);
    expect(res.json().errors[0].path).toEqual(["to"]);
  });

  it("401 with no key or unknown key", async () => {
    expect((await app.inject({ method: "POST", url: "/jobs", payload: webhook })).statusCode).toBe(401);
    expect((await post(webhook, "rq_unknown")).statusCode).toBe(401);
  });

  it("duplicate idempotencyKey returns original jobId and enqueues once", async () => {
    await queues["email.digest"].obliterate({ force: true });
    const job = { type: "email.digest", payload: { to: "a@b.co", userName: "Ann", items: [] }, idempotencyKey: "k1" };
    const first = await post(job);
    const second = await post(job);
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(200);
    expect(second.json().jobId).toBe(first.json().jobId);
    expect(await queues["email.digest"].count()).toBe(1);
    // same key, other tenant → independent job
    expect((await post(job, KEY_B)).statusCode).toBe(202);
  });
});

describe("GET /jobs/:id", () => {
  it("returns own job; other tenant gets 404", async () => {
    const { jobId } = (await post(webhook)).json();
    const own = await app.inject({ url: `/jobs/${jobId}`, headers: { authorization: `Bearer ${KEY_A}` } });
    expect(own.statusCode).toBe(200);
    expect(own.json()).toMatchObject({ id: jobId, type: "webhook.deliver", status: "queued", attempts: 0 });
    const other = await app.inject({ url: `/jobs/${jobId}`, headers: { authorization: `Bearer ${KEY_B}` } });
    expect(other.statusCode).toBe(404);
  });
});
