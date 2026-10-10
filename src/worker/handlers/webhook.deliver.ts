import { createHmac } from "node:crypto";
import type { Handler } from "./types.js";

export const sign = (raw: string, secret: string) => createHmac("sha256", secret).update(raw).digest("hex");

/**
 * POST JSON with X-RelayQ-Signature (hex HMAC-SHA256 of the raw body) and Idempotency-Key, which stays
 * the same across retries and re-deliveries so the receiver can dedupe. Non-2xx throws so BullMQ retries.
 */
// ponytail: no private-IP/SSRF guard on tenant URLs; add a resolved-IP denylist before untrusted tenants.
export async function signedPost(url: string, body: unknown, idempotencyKey: string) {
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) throw new Error("WEBHOOK_SECRET not set");
  const raw = JSON.stringify(body ?? null);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-relayq-signature": sign(raw, secret),
      "idempotency-key": idempotencyKey,
    },
    body: raw,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`POST ${url} → ${res.status}`);
  return res.status;
}

export const webhookDeliver: Handler<"webhook.deliver"> = async ({ url, body }, { jobId, once }) => ({
  status: await once("deliver", () => signedPost(url, body, `${jobId}:deliver`)),
});
