import type { PrismaClient } from "@prisma/client";
import { UnrecoverableError } from "bullmq";
import type { Redis } from "ioredis";

// Money is kept in integer micro-dollars in Redis so concurrent reservations add up exactly.
const micro = (usd: number) => Math.round(usd * 1e6);
const monthKey = (tenant: string) => `llm:budget:${tenant}:${new Date().toISOString().slice(0, 7)}`;

// Reserve only if committed spend + this reservation stays within the limit.
const RESERVE_LUA = `
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
if used + tonumber(ARGV[1]) > tonumber(ARGV[2]) then return 0 end
redis.call('INCRBY', KEYS[1], ARGV[1])
return 1`;

/**
 * Reserves `usd` of the tenant's monthly budget; false = over budget. The counter holds settled
 * spend plus open reservations. If Redis lost it, it is re-seeded from this month's ledger first.
 * ponytail: a job re-delivered after its provider call leaks that reservation until the month rolls over (over-cautious, never over-spending).
 */
export async function reserveBudget(redis: Redis, prisma: PrismaClient, tenant: string, usd: number) {
  const key = monthKey(tenant);
  if (!(await redis.exists(key))) {
    const monthStart = new Date(new Date().toISOString().slice(0, 7) + "-01T00:00:00Z");
    const spent = await prisma.llmUsage.aggregate({ _sum: { costUsd: true }, where: { tenant, createdAt: { gte: monthStart } } });
    await redis.set(key, micro(Number(spent._sum.costUsd ?? 0)), "EX", 40 * 86400, "NX");
  }
  const row = await prisma.tenantBudget.findUnique({ where: { tenant } });
  // Deny by default: a tenant with no budget row gets LLM_DEFAULT_MONTHLY_USD, which defaults to $0.
  const limit = row ? Number(row.monthlyUsdLimit) : Number(process.env.LLM_DEFAULT_MONTHLY_USD ?? 0);
  return (await redis.eval(RESERVE_LUA, 1, key, micro(usd), micro(limit))) === 1;
}

/** Replaces a reservation with what the call actually cost (0 if it failed before producing usage). */
export const settleBudget = (redis: Redis, tenant: string, reservedUsd: number, actualUsd: number) =>
  redis.incrby(monthKey(tenant), micro(actualUsd) - micro(reservedUsd));

// Token bucket: `cap` tokens, refilled continuously at cap per window. Returns 0 if taken, else ms to wait.
// Uses Redis TIME so every worker shares one clock.
const BUCKET_LUA = `
local cap = tonumber(ARGV[1]); local rate = tonumber(ARGV[2]); local need = tonumber(ARGV[3])
local t = redis.call('TIME'); local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local b = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(b[1]) or cap
local ts = tonumber(b[2]) or now
tokens = math.min(cap, tokens + (now - ts) * rate)
local wait = 0
if tokens >= need then tokens = tokens - need else wait = math.ceil((need - tokens) / rate) end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', now)
redis.call('PEXPIRE', KEYS[1], math.ceil(cap / rate) * 2)
return wait`;

/** Takes `tokens` from the provider-wide tokens-per-minute bucket. 0 = go; otherwise retry after that many ms. */
export async function takeTpm(redis: Redis, provider: string, tokens: number) {
  const cap = Number(process.env.LLM_TPM ?? 400_000);
  const windowMs = Number(process.env.LLM_TPM_WINDOW_MS ?? 60_000);
  if (tokens > cap) throw new UnrecoverableError(`request needs ${tokens} tokens, more than the ${cap} TPM bucket holds`);
  return (await redis.eval(BUCKET_LUA, 1, `llm:tpm:${provider}`, cap, cap / windowMs, tokens)) as number;
}
