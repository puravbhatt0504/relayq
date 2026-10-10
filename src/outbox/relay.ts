import type { PrismaClient } from "@prisma/client";
import type { JobData, JobType, Queues } from "../queue/queues.js";

type Row = {
  id: bigint; jobId: string; delayMs: number | null; createdAt: Date;
  type: JobType; tenant: string; priority: number; payload: unknown;
};

const BATCH = 100;

/**
 * Publishes one batch of unpublished outbox rows to BullMQ; returns how many. Rows are locked
 * with SKIP LOCKED, so concurrent relays split the work. If we die after addBulk but before
 * commit, the rows get published again; BullMQ ignores an add for a jobId it still holds, and the
 * worker skips a job whose record is already finished.
 */
export async function relayOnce(prisma: PrismaClient, queues: Queues): Promise<number> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Row[]>`
      SELECT o.id, o."jobId", o."delayMs", o."createdAt", j.type, j.tenant, j.priority, j.payload
      FROM "Outbox" o JOIN "JobRecord" j ON j.id = o."jobId"
      WHERE o."publishedAt" IS NULL
      ORDER BY o.id
      LIMIT ${BATCH}
      FOR UPDATE OF o SKIP LOCKED`;
    if (rows.length === 0) return 0;

    for (const type of new Set(rows.map((r) => r.type))) {
      await queues[type].addBulk(rows.filter((r) => r.type === type).map((r) => ({
        name: type,
        data: { tenant: r.tenant, payload: r.payload } satisfies JobData,
        opts: {
          jobId: r.jobId,
          priority: r.priority,
          delay: r.delayMs ? Math.max(0, r.createdAt.getTime() + r.delayMs - Date.now()) : undefined,
        },
      })));
    }
    await tx.outbox.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { publishedAt: new Date() } });
    // Conditional: a fast worker may already have moved it to active/completed.
    await tx.jobRecord.updateMany({ where: { id: { in: rows.map((r) => r.jobId) }, status: "pending" }, data: { status: "queued" } });
    return rows.length;
  }, { timeout: 30_000 });
}

/** Polls the outbox until stopped; drains back-to-back while batches come back full. */
export function startRelay(prisma: PrismaClient, queues: Queues, { intervalMs = 100, onError = console.error } = {}) {
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      try {
        if ((await relayOnce(prisma, queues)) === BATCH) continue;
      } catch (err) {
        onError(err);
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  })();
  return async () => {
    stopped = true;
    await loop;
  };
}

/** Daily: published outbox rows older than 7 days. */
export const cleanupOutbox = (prisma: PrismaClient) =>
  prisma.outbox.deleteMany({ where: { publishedAt: { lt: new Date(Date.now() - 7 * 86_400_000) } } });
