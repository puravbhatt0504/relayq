import type { PrismaClient } from "@prisma/client";
import { UnrecoverableError } from "bullmq";
import type { Redis } from "ioredis";
import type { z } from "zod";
import type { Once } from "../../lib/effects.js";
import type { JobType, payloadSchemas } from "../../queue/queues.js";

/** Wrap every side effect in `ctx.once(step, …)` so a re-delivered job doesn't repeat it. */
export type Handler<T extends JobType> = (
  data: z.infer<(typeof payloadSchemas)[T]>,
  ctx: { jobId: string; tenant: string; once: Once; prisma: PrismaClient; redis: Redis },
) => Promise<unknown>;
export type Handlers = { [T in JobType]: Handler<T> };

/** Throw from a handler to put the job back in the queue for `delayMs` without spending an attempt (e.g. provider 429). */
export class RetryLater extends Error {
  constructor(public delayMs: number, message = "retry later") {
    super(message);
  }
}

/** Refused by policy (e.g. budget_exceeded): not retried, recorded as `failed` with this message, not dead-lettered. */
export class Rejected extends UnrecoverableError {
  constructor(message: string) {
    super(message);
    this.name = "Rejected";
  }
}
