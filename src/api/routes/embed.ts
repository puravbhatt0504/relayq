import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { RetryLater } from "../../worker/handlers/types.js";
import { voyageEmbed } from "../../worker/handlers/embed.batch.js";

const body = z.object({
  texts: z.array(z.string().min(1).max(32_000)).min(1).max(16),
  model: z.string().min(1).default("voyage-3.5"),
});

/**
 * Synchronous embeddings for interactive use (a search query, a duplicate check before create): one provider call,
 * no queue. Bulk work (indexing cards) stays on `embed.batch`, which batches and retries.
 * ponytail: no per-tenant rate limit here beyond the provider's own 429; add one if a tenant floods it.
 */
export function embedRoutes(app: FastifyInstance) {
  app.post("/embed", async (req, reply) => {
    const b = body.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ errors: b.error.issues });
    try {
      return { model: b.data.model, embeddings: await voyageEmbed(b.data.model, b.data.texts) };
    } catch (err) {
      if (err instanceof RetryLater) return reply.code(429).header("retry-after", Math.ceil(err.delayMs / 1000)).send({ error: "provider rate limited" });
      req.log.warn({ err }, "embed failed");
      return reply.code(503).send({ error: "embeddings unavailable" });
    }
  });
}
