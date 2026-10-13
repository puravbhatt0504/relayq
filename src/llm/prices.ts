// USD per million tokens, Anthropic first-party rates (claude-api skill reference, cached 2026-10-06).
// Cache writes are 1.25x input (5-minute TTL); cache reads differ per model. Re-check against the
// pricing page when models change: this table is what budgets and the cost ledger charge.
export type Price = { input: number; output: number; cacheWrite: number; cacheRead: number };

export const prices = {
  "claude-fable-5-1": { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 0.25 },
  "claude-opus-5-5": { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  // Up to 100K input tokens; longer prompts bill at haikuLongPrompt. Cache read assumed at the usual 0.1x input.
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
} satisfies Record<string, Price>;

const haikuLongPrompt: Price = { input: 0.5, output: 2.5, cacheWrite: 0.625, cacheRead: 0.05 };

export type LlmModel = keyof typeof prices;
export const llmModels = Object.keys(prices) as LlmModel[];

export type Usage = { inputTokens: number; outputTokens: number; cacheWriteTokens?: number; cacheReadTokens?: number };

/** Exact cost in USD. Integer micro-dollar maths so totals don't drift. */
export function costUsd(model: LlmModel, u: Usage): number {
  const promptTokens = u.inputTokens + (u.cacheWriteTokens ?? 0) + (u.cacheReadTokens ?? 0);
  const p = model === "claude-haiku-5-5" && promptTokens > 100_000 ? haikuLongPrompt : prices[model];
  const micro =
    u.inputTokens * p.input + u.outputTokens * p.output + (u.cacheWriteTokens ?? 0) * p.cacheWrite + (u.cacheReadTokens ?? 0) * p.cacheRead;
  return Math.round(micro) / 1e6; // tokens × $/MTok = micro-dollars
}

/** Worst case for budgeting before the call: every input token uncached, the full maxTokens generated. */
export const estimateUsd = (model: LlmModel, inputTokens: number, maxTokens: number) =>
  costUsd(model, { inputTokens, outputTokens: maxTokens });
