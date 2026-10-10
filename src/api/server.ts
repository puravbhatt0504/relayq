import { PrismaClient } from "@prisma/client";
import Fastify from "fastify";
import { Redis } from "ioredis";
import { pathToFileURL } from "node:url";
import { createQueues, type Queues } from "../queue/queues.js";
import { authHook } from "./auth.js";
import { jobRoutes } from "./routes/jobs.js";

export type Deps = { prisma: PrismaClient; redis: Redis; queues: Queues };

export function buildApp(deps: Deps) {
  const app = Fastify({ logger: process.env.NODE_ENV !== "test" });
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
