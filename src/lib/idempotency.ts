import { Prisma } from "@prisma/client";

const TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Inside the enqueue transaction: returns the id of this tenant's job with the same key from the
 * last 24 h, or null. A stale holder has its key cleared so the unique (tenant, key) slot frees up.
 */
export async function reuse(tx: Prisma.TransactionClient, tenant: string, idempotencyKey: string) {
  const prev = await tx.jobRecord.findUnique({ where: { tenant_idempotencyKey: { tenant, idempotencyKey } } });
  if (!prev) return null;
  if (Date.now() - prev.createdAt.getTime() < TTL_MS) return prev.id;
  await tx.jobRecord.update({ where: { id: prev.id }, data: { idempotencyKey: null } });
  return null;
}

/** Two concurrent first requests with one key: the loser's insert hits the unique index. */
export const isDuplicateKey = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
