import type { Redis } from "ioredis";

const TTL_SECONDS = 86400;
const key = (tenant: string, idemKey: string) => `idem:${tenant}:${idemKey}`;

/** Claims the key for `jobId`. Returns null if claimed, or the jobId that already owns it. */
export async function claim(redis: Redis, tenant: string, idemKey: string, jobId: string) {
  const ok = await redis.set(key(tenant, idemKey), jobId, "EX", TTL_SECONDS, "NX");
  return ok ? null : await redis.get(key(tenant, idemKey));
}

/** Frees a claim when the enqueue that made it failed, so a client retry isn't stuck. */
export async function release(redis: Redis, tenant: string, idemKey: string) {
  await redis.del(key(tenant, idemKey));
}
