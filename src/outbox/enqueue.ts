import type { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { isDuplicateKey, reuse } from "../lib/idempotency.js";
import { currentTraceparent } from "../lib/tracing.js";
import type { JobType } from "../queue/queues.js";

export type NewJob = {
  tenant: string; type: JobType; payload: unknown;
  priority?: number; idempotencyKey?: string; delayMs?: number;
};

/**
 * Commits JobRecord + Outbox in one transaction (no Redis; the relay publishes after commit).
 * `created: false` means the idempotency key matched a job from the last 24 h and that id is returned.
 */
export async function enqueue(prisma: PrismaClient, job: NewJob): Promise<{ jobId: string; created: boolean }> {
  const { tenant, type, payload, priority = 5, idempotencyKey, delayMs } = job;
  const jobId = randomUUID();
  // The caller's span (enqueue), read before the transaction: inside it, Prisma's own span is active.
  const traceparent = currentTraceparent();
  try {
    const existing = await prisma.$transaction(async (tx) => {
      const prev = idempotencyKey ? await reuse(tx, tenant, idempotencyKey) : null;
      if (prev) return prev;
      await tx.jobRecord.create({ data: { id: jobId, tenant, type, priority, idempotencyKey, payload: payload as object } });
      await tx.outbox.create({ data: { jobId, delayMs, traceparent } });
      return null;
    });
    return existing ? { jobId: existing, created: false } : { jobId, created: true };
  } catch (err) {
    if (!idempotencyKey || !isDuplicateKey(err)) throw err;
    const winner = await prisma.jobRecord.findUniqueOrThrow({ where: { tenant_idempotencyKey: { tenant, idempotencyKey } } });
    return { jobId: winner.id, created: false };
  }
}
