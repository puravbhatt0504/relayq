import type { z } from "zod";
import type { Once } from "../../lib/effects.js";
import type { JobType, payloadSchemas } from "../../queue/queues.js";

/** Wrap every side effect in `ctx.once(step, …)` so a re-delivered job doesn't repeat it. */
export type Handler<T extends JobType> = (
  data: z.infer<(typeof payloadSchemas)[T]>,
  ctx: { jobId: string; tenant: string; once: Once },
) => Promise<unknown>;

/** Throw from a handler to put the job back in the queue for `delayMs` without spending an attempt (e.g. provider 429). */
export class RetryLater extends Error {
  constructor(public delayMs: number, message = "retry later") {
    super(message);
  }
}
export type Handlers = { [T in JobType]: Handler<T> };
