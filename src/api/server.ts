import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter.js";
import { FastifyAdapter } from "@bull-board/fastify";
import { PrismaClient } from "@prisma/client";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { Redis } from "ioredis";
import { timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import { registerQueueDepth, registry } from "../lib/metrics.js";
import { createQueues, type Queues } from "../queue/queues.js";
import { authHook } from "./auth.js";
import { jobRoutes } from "./routes/jobs.js";

export type Deps = { prisma: PrismaClient; redis: Redis; queues: Queues };

/** Basic auth from ADMIN_USER / ADMIN_PASSWORD; with either unset, every request is refused. */
function basicAuth(user = process.env.ADMIN_USER, pass = process.env.ADMIN_PASSWORD) {
  const expected = user && pass ? Buffer.from(`Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`) : null;
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const got = Buffer.from(req.headers.authorization ?? "");
    if (!expected || got.length !== expected.length || !timingSafeEqual(got, expected)) {
      return reply.code(401).header("www-authenticate", 'Basic realm="relayq"').send({ error: "unauthorized" });
    }
  };
}

export function buildApp(deps: Deps) {
  const app = Fastify({ logger: process.env.NODE_ENV !== "test" });
  registerQueueDepth(deps.queues);

  // ponytail: /metrics and /health are open; keep them off the public listener (ALB rule / SG) in prod.
  app.get("/metrics", async (_req, reply) => reply.type(registry.contentType).send(await registry.metrics()));
  app.get("/health", async (_req, reply) => {
    const [redis, db] = await Promise.all([
      deps.redis.ping().then(() => "ok", () => "down"),
      deps.prisma.$queryRaw`SELECT 1`.then(() => "ok", () => "down"),
    ]);
    return reply.code(redis === "ok" && db === "ok" ? 200 : 503).send({ redis, db });
  });

  app.register(async (admin) => {
    admin.addHook("onRequest", basicAuth());
    const board = new FastifyAdapter();
    board.setBasePath("/admin/queues");
    // `as never`: bull-board 5 (last Fastify-4 line) types predate bullmq's string job progress; runtime is fine.
    createBullBoard({ queues: Object.values(deps.queues).map((q) => new BullMQAdapter(q)) as never, serverAdapter: board });
    await admin.register(board.registerPlugin(), { prefix: "/admin/queues", basePath: "/admin/queues" });
  });

  app.register(async (authed) => {
    authed.addHook("preHandler", authHook(deps.prisma));
    jobRoutes(authed, deps);
  });
  return app;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
  const deps = {
    prisma: new PrismaClient(),
    redis: new Redis(redisUrl),
    queues: createQueues(new Redis(redisUrl, { maxRetriesPerRequest: null })),
  };
  await buildApp(deps).listen({ port: Number(process.env.PORT ?? 3000), host: "0.0.0.0" });
}
