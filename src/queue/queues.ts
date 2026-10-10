import { Queue, type ConnectionOptions } from "bullmq";
import { z } from "zod";

export const payloadSchemas = {
  "email.digest": z.object({
    to: z.string().email(),
    userName: z.string().min(1),
    items: z.array(z.object({ title: z.string(), url: z.string().url().optional() })),
  }),
  "board.export": z.object({
    boardId: z.string().min(1),
    format: z.enum(["csv", "json"]),
    callbackUrl: z.string().url(),
  }),
  "webhook.deliver": z.object({
    url: z.string().url(),
    body: z.unknown(),
  }),
};

export type JobType = keyof typeof payloadSchemas;
export const jobTypes = Object.keys(payloadSchemas) as JobType[];

// Retry policy is a Phase 2 concern; set here so every enqueue gets it.
export const defaultJobOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 2000 },
  removeOnComplete: 1000,
  removeOnFail: false,
};

// One BullMQ queue per job type, so per-type limiters (Phase 3) are plain queue limiters.
// `dead` holds jobs that exhausted their attempts; nothing consumes it.
export function createQueues(connection: ConnectionOptions, jobOptions = defaultJobOptions) {
  return Object.fromEntries(
    [...jobTypes, "dead"].map((t) => [t, new Queue(t, { connection, defaultJobOptions: jobOptions })]),
  ) as Record<JobType | "dead", Queue>;
}
export type Queues = ReturnType<typeof createQueues>;
