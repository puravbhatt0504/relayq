import { Counter, Gauge, Histogram, Registry } from "prom-client";
import type { Queues } from "../queue/queues.js";

// The API and each worker process serve their own copy; Prometheus scrapes them all and sums.
export const registry = new Registry();

export const jobsTotal = new Counter({
  name: "relayq_jobs_total",
  help: "Job attempts finished, by outcome (failed = will retry, dead = out of attempts)",
  labelNames: ["type", "status"] as const,
  registers: [registry],
});

export const jobDuration = new Histogram({
  name: "relayq_job_duration_seconds",
  help: "Handler run time per attempt",
  labelNames: ["type"] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [registry],
});

export const llmTokens = new Counter({
  name: "relayq_llm_tokens_total",
  help: "LLM tokens by model and kind (input, output, cache_write, cache_read)",
  labelNames: ["model", "kind"] as const,
  registers: [registry],
});

export const llmCost = new Counter({
  name: "relayq_llm_cost_usd_total",
  help: "LLM spend in USD, priced from src/llm/prices.ts",
  labelNames: ["tenant", "model"] as const,
  registers: [registry],
});

export const llmLatency = new Histogram({
  name: "relayq_llm_latency_seconds",
  help: "Provider call latency for the call that produced the result",
  labelNames: ["model"] as const,
  buckets: [0.5, 1, 2, 5, 10, 20, 30, 60],
  registers: [registry],
});

/** Waiting + prioritized + delayed per queue, read from Redis at scrape time. Register in the API only. */
export function registerQueueDepth(queues: Queues) {
  registry.removeSingleMetric("relayq_queue_depth");
  new Gauge({
    name: "relayq_queue_depth",
    help: "Jobs not yet picked up, per queue",
    labelNames: ["queue"] as const,
    registers: [registry],
    async collect() {
      for (const [name, q] of Object.entries(queues)) {
        const c = await q.getJobCounts("waiting", "prioritized", "delayed");
        this.set({ queue: name }, c.waiting + c.prioritized + c.delayed);
      }
    },
  });
}
