import { expect, it } from "vitest";
import { costUsd, estimateUsd, prices } from "../src/llm/prices.js";

it("charges each token kind at its own rate", () => {
  // 1M of each kind on Opus 5.5 = 4 + 20 + 5 + 0.2
  expect(costUsd("claude-opus-5-5", { inputTokens: 1e6, outputTokens: 1e6, cacheWriteTokens: 1e6, cacheReadTokens: 1e6 })).toBe(29.2);
  expect(costUsd("claude-sonnet-5-5", { inputTokens: 1000, outputTokens: 1800 })).toBe(0.02); // 0.002 + 0.018
  expect(costUsd("claude-fable-5-1", { inputTokens: 0, outputTokens: 0, cacheReadTokens: 4_000_000 })).toBe(1); // $0.25/MTok
});

it("cache writes are 1.25x input on every model", () => {
  for (const p of Object.values(prices)) expect(p.cacheWrite).toBeCloseTo(p.input * 1.25, 10);
});

it("haiku switches to the long-prompt rate above 100K prompt tokens", () => {
  expect(costUsd("claude-haiku-5-5", { inputTokens: 100_000, outputTokens: 0 })).toBe(0.01);
  expect(costUsd("claude-haiku-5-5", { inputTokens: 100_001, outputTokens: 0 })).toBe(0.050001);
});

it("rounds to whole micro-dollars and estimates worst case", () => {
  expect(costUsd("claude-haiku-5-5", { inputTokens: 3, outputTokens: 0 })).toBe(0); // 0.3 micro-dollars
  expect(estimateUsd("claude-sonnet-5-5", 1000, 1800)).toBe(0.02);
});
