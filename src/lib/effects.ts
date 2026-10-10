import { Prisma, type PrismaClient } from "@prisma/client";

export type Once = <T>(step: string, fn: (tx: Prisma.TransactionClient) => Promise<T>) => Promise<T>;

/**
 * Runs `fn` at most once per (jobId, step) across re-deliveries. DB writes `fn` makes through `tx`
 * commit atomically with the EffectLog row. External calls can't join the transaction: a crash
 * between the call and the commit re-runs it, so pass `${jobId}:${step}` downstream as an
 * idempotency key and let the receiver dedupe.
 */
export async function once<T>(
  prisma: PrismaClient, jobId: string, step: string, fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  const done = await prisma.effectLog.findUnique({ where: { jobId_step: { jobId, step } } });
  if (done) return done.result as T;
  // Timeout covers a 10 s outbound HTTP call inside fn.
  return prisma.$transaction(async (tx) => {
    const result = await fn(tx);
    await tx.effectLog.create({ data: { jobId, step, result: (result ?? Prisma.DbNull) as Prisma.InputJsonValue } });
    return result;
  }, { timeout: 20_000 });
}
