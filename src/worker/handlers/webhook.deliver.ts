import { createHmac } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { BlockedUrl, guardedLookup, isAllowed, isBlockedIp } from "../../lib/ssrf.js";
import { injectTrace } from "../../lib/tracing.js";
import { Rejected, type Handler } from "./types.js";

export const sign = (raw: string, secret: string) => createHmac("sha256", secret).update(raw).digest("hex");

/**
 * POST JSON with X-RelayQ-Signature (hex HMAC-SHA256 of the raw body) and Idempotency-Key, which stays
 * the same across retries and re-deliveries so the receiver can dedupe. Non-2xx throws so BullMQ retries.
 * URLs come from tenants, so private/metadata addresses are refused (Rejected: not retried) and
 * redirects are not followed (a 3xx is a failure like any non-2xx).
 */
export async function signedPost(url: string, body: unknown, idempotencyKey: string) {
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) throw new Error("WEBHOOK_SECRET not set");
  const u = new URL(url);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Rejected(`blocked_url: scheme ${u.protocol}`);
  const host = u.hostname.replace(/^[|]$/g, "");
  const port = u.port || (u.protocol === "https:" ? "443" : "80");
  const allowed = isAllowed(host, port);
  // lookup isn't consulted for literal IPs, so check those here.
  if (!allowed && isIP(host) && isBlockedIp(host)) throw new Rejected(`blocked_url: ${host} is a blocked address`);

  const raw = JSON.stringify(body ?? null);
  // traceparent: the receiver (e.g. PulseBoard's export callback) continues this job's trace.
  const headers = injectTrace({
    "content-type": "application/json",
    "x-relayq-signature": sign(raw, secret),
    "idempotency-key": idempotencyKey,
  });
  const status = await new Promise<number>((resolve, reject) => {
    const req = (u.protocol === "https:" ? httpsRequest : httpRequest)(u, {
      method: "POST", headers, lookup: allowed ? undefined : guardedLookup, timeout: 10_000,
    }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 0)).on("error", reject); });
    req.on("timeout", () => req.destroy(new Error(`POST ${url} timed out`)));
    req.on("error", (err) => reject(err instanceof BlockedUrl ? new Rejected(`blocked_url: ${err.message}`) : err));
    req.end(raw);
  });
  if (status < 200 || status >= 300) throw new Error(`POST ${url} → ${status}`);
  return status;
}

export const webhookDeliver: Handler<"webhook.deliver"> = async ({ url, body }, { jobId, once }) => ({
  status: await once("deliver", () => signedPost(url, body, `${jobId}:deliver`)),
});
