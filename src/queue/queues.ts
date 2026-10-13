import { Queue, type ConnectionOptions } from "bullmq";
import { z } from "zod";
import { llmModels, type LlmModel } from "../llm/prices.js";

const llmModel = z.enum(llmModels as [LlmModel, ...LlmModel[]]);

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
  // Tenant comes from the API key, not the payload.
  "embed.batch": z.object({
    items: z.array(z.object({ id: z.string().min(1), text: z.string().min(1).max(32_000) })).min(1).max(128),
    model: z.string().min(1).default("voyage-3.5"),
    callbackUrl: z.string().url(),
  }),
  // Model must be in the price table: budgets and the cost ledger depend on it.
  "llm.complete": z.object({
    model: llmModel,
    fallbackModel: llmModel.optional(),
    system: z.string().default(""),
    messages: z.array(z.object({
      role: z.enum(["user", "assistant"]),
      content: z.union([z.string().min(1), z.array(z.record(z.unknown())).min(1)]),
    })).min(1),
    tools: z.array(z.record(z.unknown())).optional(),
    maxTokens: z.number().int().min(1).max(16_000), // non-streaming call with a 60 s timeout
    callbackUrl: z.string().url(),
  }),
};

export type JobType = keyof typeof payloadSchemas;
export const jobTypes = Object.keys(payloadSchemas) as JobType[];

/** What sits in a BullMQ job's data: the tenant rides along for per-tenant rate limiting. */
export type JobData = { tenant: string; payload: unknown; traceparent?: string };

/** Per-type ceilings, shared by every worker process (BullMQ keeps the limiter in Redis). */
export const typeLimits: Partial<Record<JobType, { max: number; duration: number }>> = {
  "email.digest": { max: 14, duration: 1000 }, // SES sandbox ceiling
};

/** Per-type worker concurrency (default WORKER_CONCURRENCY). Embeds need many jobs in flight for the batcher to coalesce. */
export const typeConcurrency: Partial<Record<JobType, number>> = {
  "embed.batch": 128,
};

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
