import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { isDuplicateKey, reuse } from "../../lib/idempotency.js";
import { jobTypes, payloadSchemas, type JobType } from "../../queue/queues.js";
import type { Deps } from "../server.js";

const body = z.object({
  type: z.string(),
  payload: z.unknown(),
  idempotencyKey: z.string().min(1).max(200).optional(),
  delayMs: z.number().int().nonnegative().optional(),
  priority: z.number().int().min(1).max(10).default(5),
});

const MAX_QUEUED_PER_TENANT = 10_000;

export function jobRoutes(app: FastifyInstance, { prisma, queues }: Deps) {
  app.post("/jobs", async (req, reply) => {
    const b = body.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ errors: b.error.issues });
    const { type, idempotencyKey, delayMs, priority } = b.data;
    if (!jobTypes.includes(type as JobType)) {
      return reply.code(400).send({ errors: [{ path: ["type"], message: `must be one of ${jobTypes.join(", ")}` }] });
    }
    const p = payloadSchemas[type as JobType].safeParse(b.data.payload);
    if (!p.success) return reply.code(400).send({ errors: p.error.issues });

    const { tenant } = req;
    const backlog = await prisma.jobRecord.count({ where: { tenant, status: { in: ["pending", "queued"] } } });
    if (backlog >= MAX_QUEUED_PER_TENANT) return reply.code(429).send({ error: `over ${MAX_QUEUED_PER_TENANT} queued jobs` });

    // One transaction, no Redis: the outbox relay publishes after commit.
    const jobId = randomUUID();
    try {
      const existing = await prisma.$transaction(async (tx) => {
        const prev = idempotencyKey ? await reuse(tx, tenant, idempotencyKey) : null;
        if (prev) return prev;
        await tx.jobRecord.create({ data: { id: jobId, tenant, type, priority, idempotencyKey, payload: p.data as object } });
        await tx.outbox.create({ data: { jobId, delayMs } });
        return null;
      });
      if (existing) return reply.code(200).send({ jobId: existing, status: "queued" });
    } catch (err) {
      if (!idempotencyKey || !isDuplicateKey(err)) throw err;
      const winner = await prisma.jobRecord.findUniqueOrThrow({ where: { tenant_idempotencyKey: { tenant, idempotencyKey } } });
      return reply.code(200).send({ jobId: winner.id, status: "queued" });
    }
    return reply.code(202).send({ jobId, status: "queued" });
  });

  app.get<{ Params: { id: string } }>("/jobs/:id", async (req, reply) => {
    const job = await prisma.jobRecord.findFirst({ where: { id: req.params.id, tenant: req.tenant } });
    if (!job) return reply.code(404).send({ error: "not found" });
    const { id, type, status, attempts, result, error } = job;
    return { id, type, status, attempts, result: result ?? undefined, error: error ?? undefined };
  });

  // Re-queues a dead job under the same id with a fresh attempt count.
  app.post<{ Params: { id: string } }>("/jobs/:id/retry", async (req, reply) => {
    const rec = await prisma.jobRecord.findFirst({ where: { id: req.params.id, tenant: req.tenant } });
    if (!rec) return reply.code(404).send({ error: "not found" });
    if (rec.status !== "dead") return reply.code(409).send({ error: "only dead jobs can be retried" });
    const queue = queues[rec.type as JobType];
    // BullMQ ignores add() for an id that still exists, so drop the old failed copy first.
    await Promise.all([queue.remove(rec.id), queues.dead.remove(rec.id)]);
    // Back through the outbox, same as a new job. Steps that already succeeded stay in EffectLog and are skipped.
    await prisma.$transaction([
      prisma.jobRecord.update({ where: { id: rec.id }, data: { status: "pending", attempts: 0, error: null, result: Prisma.DbNull } }),
      prisma.outbox.upsert({
        where: { jobId: rec.id },
        create: { jobId: rec.id },
        update: { publishedAt: null, delayMs: null, createdAt: new Date() },
      }),
    ]);
    return reply.code(202).send({ jobId: rec.id, status: "queued" });
  });
}
