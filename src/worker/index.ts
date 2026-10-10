import { Prisma, PrismaClient } from "@prisma/client";
import { Worker, type ConnectionOptions, type Queue } from "bullmq";
import { Redis } from "ioredis";
import { pathToFileURL } from "node:url";
import { createQueues, jobTypes } from "../queue/queues.js";
import { boardExport } from "./handlers/board.export.js";
import { emailDigest } from "./handlers/email.digest.js";
import type { Handler, Handlers } from "./handlers/types.js";
import { webhookDeliver } from "./handlers/webhook.deliver.js";

export const defaultHandlers: Handlers = {
  "email.digest": emailDigest,
  "board.export": boardExport,
  "webhook.deliver": webhookDeliver,
};

type Opts = { connection: ConnectionOptions; prisma: PrismaClient; dead: Queue; handlers?: Handlers; concurrency?: number };

export function startWorkers({ connection, prisma, dead, handlers = defaultHandlers, concurrency }: Opts) {
  concurrency ??= Number(process.env.WORKER_CONCURRENCY ?? 5);
  const workers = jobTypes.map((type) => {
    const handle = handlers[type] as Handler<typeof type>;
    return new Worker(type, async (job) => {
      const id = job.id!;
      const attempts = job.attemptsMade + 1;
      await prisma.jobRecord.update({ where: { id }, data: { status: "active", attempts } });
      try {
        const result = await handle(job.data, { jobId: id });
        await prisma.jobRecord.update({
          where: { id },
          data: { status: "completed", result: (result ?? Prisma.DbNull) as Prisma.InputJsonValue, error: null },
        });
        return result;
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        const last = attempts >= (job.opts.attempts ?? 1);
        if (last) await dead.add(type, { type, payload: job.data, error }, { jobId: id });
        await prisma.jobRecord.update({ where: { id }, data: { status: last ? "dead" : "failed", error } });
        throw err;
      }
    }, { connection, concurrency });
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

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const connection = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: null });
  const { dead } = createQueues(connection);
  const { close } = startWorkers({ connection, prisma: new PrismaClient(), dead });
  onSigterm(close);
}
