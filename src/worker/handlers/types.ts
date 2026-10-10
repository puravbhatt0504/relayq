import type { z } from "zod";
import type { Once } from "../../lib/effects.js";
import type { JobType, payloadSchemas } from "../../queue/queues.js";

/** Wrap every side effect in `ctx.once(step, …)` so a re-delivered job doesn't repeat it. */
export type Handler<T extends JobType> = (
  data: z.infer<(typeof payloadSchemas)[T]>,
  ctx: { jobId: string; once: Once },
) => Promise<unknown>;
export type Handlers = { [T in JobType]: Handler<T> };
