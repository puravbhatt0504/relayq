import { UnrecoverableError } from "bullmq";
import { EmbedBatcher } from "../embed-batcher.js";
import { RetryLater, type Handler } from "./types.js";
import { signedPost } from "./webhook.deliver.js";

/** Voyage embeddings API. VOYAGE_BASE_URL lets tests point it at a mock. */
export async function voyageEmbed(model: string, texts: string[]): Promise<number[][]> {
  const key = process.env.VOYAGE_API_KEY;
  if (!key) throw new UnrecoverableError("VOYAGE_API_KEY not set");
  const res = await fetch(`${process.env.VOYAGE_BASE_URL ?? "https://api.voyageai.com"}/v1/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ input: texts, model }),
    signal: AbortSignal.timeout(60_000),
  });
  if (res.status === 429) {
    // Back off for as long as the provider asks, without spending a retry attempt.
    const seconds = Number(res.headers.get("retry-after"));
    throw new RetryLater(Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 1000, "provider rate limited");
  }
  if (res.status >= 500) throw new Error(`embeddings provider ${res.status}`); // normal backoff
  if (!res.ok) throw new UnrecoverableError(`embeddings provider ${res.status}: ${await res.text()}`);
  const { data } = (await res.json()) as { data: { index: number; embedding: number[] }[] };
  return data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

const batcher = new EmbedBatcher(voyageEmbed);

// The callback is once(): a re-delivered job re-embeds (cheap, idempotent) but never re-POSTs a delivered result.
export const embedBatch: Handler<"embed.batch"> = async ({ items, model, callbackUrl }, { jobId, tenant, once }) => {
  const vectors = await batcher.embed(`${tenant}:${model}`, model, items);
  await once("callback", () =>
    signedPost(callbackUrl, { items: items.map((it, i) => ({ id: it.id, embedding: vectors[i] })) }, `${jobId}:callback`),
  );
  return { items: items.length, dimensions: vectors[0]?.length ?? 0 }; // vectors go to the callback, not the job record
};
