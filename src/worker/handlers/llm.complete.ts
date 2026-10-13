import Anthropic from "@anthropic-ai/sdk";
import { UnrecoverableError } from "bullmq";
import { llmCost, llmLatency, llmTokens } from "../../lib/metrics.js";
import { reserveBudget, settleBudget, takeTpm } from "../../llm/limits.js";
import { costUsd, estimateUsd, type LlmModel, type Usage } from "../../llm/prices.js";
import { Rejected, RetryLater, type Handler } from "./types.js";
import { signedPost } from "./webhook.deliver.js";

// The SDK reads ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL (tests point that at a mock). Retries are ours,
// not the SDK's: two overloads on the primary, then the fallback. 60 s per call, per the contract.
const client = () => new Anthropic({ maxRetries: 0, timeout: 60_000 });

const isOverloadOrTimeout = (err: unknown) =>
  err instanceof Anthropic.APIConnectionTimeoutError ||
  (err instanceof Anthropic.APIError && (err.status === 529 || err.type === "overloaded_error"));

/** Provider 429: wait as long as it says, without spending an attempt. */
function asRetryLater(err: unknown) {
  if (!(err instanceof Anthropic.RateLimitError)) return err;
  const seconds = Number(err.headers?.get("retry-after"));
  return new RetryLater(Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 5000, "provider rate limited");
}

// ponytail: token count of the system prompt estimated as chars/4 for the 1,024-token caching threshold; count it exactly if that misfires.
const systemBlocks = (system: string): Anthropic.TextBlockParam[] | undefined =>
  system ? [{ type: "text", text: system, ...(system.length / 4 > 1024 ? { cache_control: { type: "ephemeral" } } : {}) }] : undefined;

export const llmComplete: Handler<"llm.complete"> = async (p, { jobId, tenant, once, prisma, redis }) => {
  const anthropic = client();
  if (!anthropic.apiKey) throw new UnrecoverableError("ANTHROPIC_API_KEY not set");
  const request = {
    max_tokens: p.maxTokens,
    system: systemBlocks(p.system),
    messages: p.messages as Anthropic.MessageParam[],
    tools: p.tools as Anthropic.Tool[] | undefined,
  };

  // 1. Size the call: exact input tokens from the provider's counter, worst case output = maxTokens.
  const { input_tokens } = await anthropic.messages.countTokens({ model: p.model, system: request.system, messages: request.messages, tools: request.tools });

  // 2. Shared tokens-per-minute bucket across all workers.
  const wait = await takeTpm(redis, "anthropic", input_tokens + p.maxTokens);
  if (wait > 0) throw new RetryLater(wait, "provider TPM limit");

  // 3. Budget: reserve the worst case (on whichever model could end up serving it) before any spend.
  const reserved = Math.max(estimateUsd(p.model, input_tokens, p.maxTokens), p.fallbackModel ? estimateUsd(p.fallbackModel, input_tokens, p.maxTokens) : 0);
  if (!(await reserveBudget(redis, prisma, tenant, reserved))) {
    await once("budget-webhook", () => signedPost(p.callbackUrl, { jobId, error: "budget_exceeded", estimatedUsd: reserved }, `${jobId}:budget-webhook`));
    throw new Rejected("budget_exceeded");
  }

  // 4. Call: primary up to twice on overload/timeout, then one try on the fallback.
  const started = Date.now();
  let message: Anthropic.Message;
  let modelUsed: LlmModel = p.model;
  try {
    message = await callWithFallback(anthropic, request, p.model, p.fallbackModel, (m) => (modelUsed = m));
  } catch (err) {
    await settleBudget(redis, tenant, reserved, 0); // nothing billed, release the hold
    throw asRetryLater(err);
  }
  const latencyMs = Date.now() - started;

  // 5. Price what actually happened and record it once.
  const u = message.usage;
  const usage: Usage = {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
  };
  const cost = costUsd(modelUsed, usage);
  await settleBudget(redis, tenant, reserved, cost);
  await once("ledger", async (tx) => {
    await tx.llmUsage.create({ data: { jobId, tenant, model: modelUsed, ...usage, costUsd: cost, latencyMs } });
    llmTokens.inc({ model: modelUsed, kind: "input" }, usage.inputTokens);
    llmTokens.inc({ model: modelUsed, kind: "output" }, usage.outputTokens);
    llmTokens.inc({ model: modelUsed, kind: "cache_write" }, usage.cacheWriteTokens);
    llmTokens.inc({ model: modelUsed, kind: "cache_read" }, usage.cacheReadTokens);
    llmCost.inc({ tenant, model: modelUsed }, cost);
    llmLatency.observe({ model: modelUsed }, latencyMs / 1000);
  });

  const result = { modelUsed, stopReason: message.stop_reason, content: message.content, usage, costUsd: cost };
  await once("callback", () => signedPost(p.callbackUrl, { jobId, ...result }, `${jobId}:callback`));
  return result;
};

async function callWithFallback(
  anthropic: Anthropic,
  request: Omit<Anthropic.MessageCreateParamsNonStreaming, "model">,
  primary: LlmModel,
  fallback: LlmModel | undefined,
  onModel: (m: LlmModel) => void,
) {
  for (let i = 0; i < 2; i++) {
    try {
      return await anthropic.messages.create({ ...request, model: primary });
    } catch (err) {
      if (!isOverloadOrTimeout(err)) throw err;
    }
  }
  if (!fallback) throw new Error(`${primary} overloaded twice and no fallbackModel`); // normal backoff
  onModel(fallback);
  return anthropic.messages.create({ ...request, model: fallback });
}
