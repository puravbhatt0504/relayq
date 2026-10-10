import type { z } from "zod";
import type { JobType, payloadSchemas } from "../../queue/queues.js";

export type Handler<T extends JobType> = (data: z.infer<(typeof payloadSchemas)[T]>, ctx: { jobId: string }) => Promise<unknown>;
export type Handlers = { [T in JobType]: Handler<T> };
