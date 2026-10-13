import { Prisma, PrismaClient } from "@prisma/client";
import { DelayedError, Worker, type Job, type Queue } from "bullmq";
import { Redis } from "ioredis";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { pino } from "pino";
import { once } from "../lib/effects.js";
import { contextFrom, SpanKind, withSpan } from "../lib/tracing.js";
import { jobDuration, jobsTotal, registry } from "../lib/metrics.js";
import { createQueues, jobTypes, typeLimits, type JobData } from "../queue/queues.js";
import { boardExport } from "./handlers/board.export.js";
import { emailDigest } from "./handlers/email.digest.js";
import type { Handler, Handlers } from "./handlers/types.js";
import { webhookDeliver } from "./handlers/webhook.deliver.js";

const logger = pino({ name: "relayq-worker", enabled: process.env.NODE_ENV !== "test" });

export const defaultHandlers: Handlers = {
  "email.digest": emailDigest,
  "board.export": boardExport,
  "webhook.deliver": webhookDeliver,
};

type Limit = { max: number; windowMs: number };
type Opts = {
  connection: Redis; prisma: PrismaClient; dead: Queue;
  handlers?: Handlers; concurrency?: number; tenantLimit?: Limit;
};

// Fixed window that opens on a tenant's first job; returns ms until it closes if over the limit, else 0.
// ponytail: fixed window allows up to 2×max across a boundary, and every throttled job wakes at window end; sliding log / token bucket if that matters.
const WINDOW_LUA = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
if n > tonumber(ARGV[2]) then return redis.call('PTTL', KEYS[1]) end
return 0`;

export function startWorkers({ connection, prisma, dead, handlers = defaultHandlers, concurrency, tenantLimit }: Opts) {
  concurrency ??= Number(process.env.WORKER_CONCURRENCY ?? 5);
  const limit = tenantLimit ?? { max: Number(process.env.TENANT_JOBS_PER_MIN ?? 100), windowMs: 60_000 };
  const workers = jobTypes.map((type) => {
    const handle = handlers[type] as Handler<typeof type>;
    const worker = new Worker(type, async (job: Job<JobData>, token) => {
      const id = job.id!;
      const { tenant, payload } = job.data;
      const wait = (await connection.eval(WINDOW_LUA, 1, `rl:tenant:${tenant}`, limit.windowMs, limit.max)) as number;
      if (wait > 0) {
        // Over the tenant's limit: park it until the window closes. Stays "queued"; no attempt used.
        await job.moveToDelayed(Date.now() + wait, token);
        throw new DelayedError();
      }
      const attempts = job.attemptsMade + 1;
      // One span per attempt, a child of the enqueue span (same trace as the caller's request).
      const parent = contextFrom({ traceparent: job.data.traceparent });
      const attrs = { "relayq.job_id": id, "relayq.tenant": tenant, "relayq.attempt": String(attempts) };
      return withSpan(`process ${type}`, SpanKind.CONSUMER, parent, attrs, async () => {
        const log = logger.child({ jobId: id, type, tenant, attempt: attempts });
        // A finished record means this is a stale re-delivery (e.g. outbox re-published after a crash).
        const { count } = await prisma.jobRecord.updateMany({
          where: { id, status: { notIn: ["completed", "dead"] } },
          data: { status: "active", attempts },
        });
        if (count === 0) {
          log.warn("job already finished, skipping re-delivery");
          return null;
        }
        log.info("job started");
        const timer = jobDuration.startTimer({ type });
        try {
          const result = await handle(payload as never, { jobId: id, once: (step, fn) => once(prisma, id, step, fn) });
          timer();
          await prisma.jobRecord.update({
            where: { id },
            data: { status: "completed", result: (result ?? Prisma.DbNull) as Prisma.InputJsonValue, error: null },
          });
          jobsTotal.inc({ type, status: "completed" });
          log.info("job completed");
          return result;
        } catch (err) {
          timer();
          const error = err instanceof Error ? err.message : String(err);
          const last = attempts >= (job.opts.attempts ?? 1);
          if (last) await dead.add(type, { type, tenant, payload, error }, { jobId: id });
          await prisma.jobRecord.update({ where: { id }, data: { status: last ? "dead" : "failed", error } });
          jobsTotal.inc({ type, status: last ? "dead" : "failed" });
          log[last ? "error" : "warn"]({ err: error }, last ? "job dead" : "job failed, will retry");
          throw err;
        }
      });
    }, {
      connection, concurrency, limiter: typeLimits[type],
      // A killed worker leaves its jobs stalled; they're re-delivered (once() keeps effects single).
      // Default 1 would fail a job hit by two kills, so allow more.
      maxStalledCount: 10,
    });
    // Stall-exhausted jobs fail without entering the processor's catch; settle their record here.
    worker.on("failed", async (job, err) => {
      if (!job?.id || !/stalled/i.test(err.message)) return;
      const { tenant, payload } = job.data;
      await dead.add(type, { type, tenant, payload, error: err.message }, { jobId: job.id });
      await prisma.jobRecord.update({ where: { id: job.id }, data: { status: "dead", error: err.message } });
      jobsTotal.inc({ type, status: "dead" });
    });
    return worker;
  });
  // Worker.close() stops fetching new jobs and waits for active ones.
  return { workers, close: () => Promise.all(workers.map((w) => w.close())).then(() => {}) };
}

export function onSigterm(close: () => Promise<void>, exit: (code: number) => void = process.exit, graceMs = 30_000) {
  process.once("SIGTERM", async () => {
    const timer = setTimeout(() => exit(1), graceMs);
    await close();
    clearTimeout(timer);
    exit(0);
  });
}

export function main() {
  const connection = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: null });
  const { dead } = createQueues(connection);
  const { close } = startWorkers({ connection, prisma: new PrismaClient(), dead });
  const metrics = createServer(async (_req, res) => {
    res.setHeader("content-type", registry.contentType);
    res.end(await registry.metrics());
  }).listen(Number(process.env.METRICS_PORT ?? 9100));
  onSigterm(() => close().then(() => void metrics.close()));
  logger.info("worker started");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
