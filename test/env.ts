import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer } from "@testcontainers/redis";
import { PrismaClient } from "@prisma/client";
import { Redis } from "ioredis";
import { execSync } from "node:child_process";
import { hashKey } from "../src/api/auth.js";
import { buildApp } from "../src/api/server.js";
import { createQueues, defaultJobOptions } from "../src/queue/queues.js";

export const KEY_A = "rq_tenantA_secret";
export const KEY_B = "rq_tenantB_secret";

/** Real Postgres + Redis, schema pushed, tenants A and B seeded, app built. */
export async function startEnv(jobOptions = defaultJobOptions) {
  const [pg, rc] = await Promise.all([
    new PostgreSqlContainer("postgres:16-alpine").start(),
    new RedisContainer("redis:7-alpine").start(),
  ]);
  const dbUrl = pg.getConnectionUri();
  execSync("npx prisma migrate deploy",{ env: { ...process.env, DATABASE_URL: dbUrl }, stdio: "ignore" });
  const prisma = new PrismaClient({ datasourceUrl: dbUrl });
  await prisma.apiKey.createMany({ data: [{ hash: hashKey(KEY_A), tenant: "A" }, { hash: hashKey(KEY_B), tenant: "B" }] });
  const redis = new Redis(rc.getConnectionUrl());
  const connection = new Redis(rc.getConnectionUrl(), { maxRetriesPerRequest: null });
  const queues = createQueues(connection, jobOptions);
  const app = buildApp({ prisma, redis, queues });

  const auth = (key: string) => ({ authorization: `Bearer ${key}` });
  const post = (body: unknown, key = KEY_A) => app.inject({ method: "POST", url: "/jobs", headers: auth(key), payload: body as object });
  const retry = (id: string, key = KEY_A) => app.inject({ method: "POST", url: `/jobs/${id}/retry`, headers: auth(key) });
  const get = (path: string, key = KEY_A) => app.inject({ url: path, headers: auth(key) });

  async function stop() {
    await app.close();
    await Promise.all(Object.values(queues).map((q) => q.close()));
    redis.disconnect();
    connection.disconnect();
    await prisma.$disconnect();
    await Promise.all([pg.stop(), rc.stop()]);
  }
  return { prisma, redis, connection, queues, app, post, retry, get, stop };
}

export async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}
