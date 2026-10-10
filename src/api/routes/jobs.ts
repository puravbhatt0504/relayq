import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { claim, release } from "../../lib/idempotency.js";
import { jobTypes, payloadSchemas, type JobType } from "../../queue/queues.js";
import type { Deps } from "../server.js";

const body = z.object({
  type: z.string(),
  payload: z.unknown(),
  idempotencyKey: z.string().min(1).max(200).optional(),
  delayMs: z.number().int().nonnegative().optional(),
});

export function jobRoutes(app: FastifyInstance, { prisma, redis, queues }: Deps) {
  app.post("/jobs", async (req, reply) => {
    const b = body.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ errors: b.error.issues });
    const { type, idempotencyKey, delayMs } = b.data;
    if (!jobTypes.includes(type as JobType)) {
      return reply.code(400).send({ errors: [{ path: ["type"], message: `must be one of ${jobTypes.join(", ")}` }] });
    }
    const p = payloadSchemas[type as JobType].safeParse(b.data.payload);
    if (!p.success) return reply.code(400).send({ errors: p.error.issues });

    const jobId = randomUUID();
    if (idempotencyKey) {
      const existing = await claim(redis, req.tenant, idempotencyKey, jobId);
      if (existing) return reply.code(200).send({ jobId: existing, status: "queued" });
    }
    try {
      await prisma.jobRecord.create({ data: { id: jobId, tenant: req.tenant, type, payload: p.data as object } });
      await queues[type as JobType].add(type, p.data, { jobId, delay: delayMs });
    } catch (err) {
      if (idempotencyKey) await release(redis, req.tenant, idempotencyKey);
      throw err;
    }
    return reply.code(202).send({ jobId, status: "queued" });
  });

  app.get<{ Params: { id: string } }>("/jobs/:id", async (req, reply) => {
    const job = await prisma.jobRecord.findFirst({ where: { id: req.params.id, tenant: req.tenant } });
    if (!job) return reply.code(404).send({ error: "not found" });
    const { id, type, status, attempts, result, error } = job;
    return { id, type, status, attempts, result: result ?? undefined, error: error ?? undefined };
  });
}
