import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KEY_B, startEnv } from "./env.js";

let env: Awaited<ReturnType<typeof startEnv>>;
const now = new Date();
const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15));
const lastMonthKey = lastMonth.toISOString().slice(0, 7);
const admin = { authorization: `Basic ${Buffer.from("root:pw").toString("base64")}` };

beforeAll(async () => {
  Object.assign(process.env, { ADMIN_USER: "root", ADMIN_PASSWORD: "pw" });
  delete process.env.LLM_DEFAULT_MONTHLY_USD;
  env = await startEnv({ relay: false });
  const row = (tenant: string, model: string, costUsd: number, createdAt = now) =>
    ({ jobId: `j-${Math.random()}`, tenant, model, inputTokens: 100, outputTokens: 10, cacheReadTokens: 5, costUsd, latencyMs: 1, createdAt });
  await env.prisma.llmUsage.createMany({ data: [
    row("A", "claude-sonnet-5-5", 0.3), row("A", "claude-sonnet-5-5", 0.2), row("A", "claude-haiku-5-5", 0.05),
    row("A", "claude-sonnet-5-5", 9, lastMonth),
    row("B", "claude-opus-5-5", 4),
  ] });
  await env.prisma.tenantBudget.create({ data: { tenant: "A", monthlyUsdLimit: 1 } });
});
afterAll(() => env?.stop());

describe("GET /llm/usage", () => {
  it("this month: own settled spend, remaining budget, per-model breakdown by cost", async () => {
    const res = await env.get("/llm/usage");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      month: now.toISOString().slice(0, 7), limitUsd: 1, spentUsd: 0.55, remainingUsd: 0.45,
      byModel: [
        { model: "claude-sonnet-5-5", calls: 2, inputTokens: 200, outputTokens: 20, cacheWriteTokens: 0, cacheReadTokens: 10, costUsd: 0.5 },
        { model: "claude-haiku-5-5", calls: 1, inputTokens: 100, outputTokens: 10, cacheWriteTokens: 0, cacheReadTokens: 5, costUsd: 0.05 },
      ],
    });
  });

  it("?month=last month → that month only; remaining never negative", async () => {
    expect((await env.get(`/llm/usage?month=${lastMonthKey}`)).json()).toMatchObject({ month: lastMonthKey, spentUsd: 9, remainingUsd: 0 });
  });

  it("bad month → 400", async () => {
    expect((await env.get("/llm/usage?month=2026-13")).statusCode).toBe(400);
    expect((await env.get("/llm/usage?month=abc")).statusCode).toBe(400);
  });

  it("no budget row, no env default → limit 0", async () => {
    expect((await env.get("/llm/usage", KEY_B)).json()).toMatchObject({ limitUsd: 0, spentUsd: 4, remainingUsd: 0 });
  });
});

describe("/admin/budgets", () => {
  const put = (tenant: string, body: unknown, headers = admin) =>
    env.app.inject({ method: "PUT", url: `/admin/budgets/${tenant}`, headers, payload: body as object });

  it("needs admin auth", async () => {
    expect((await put("B", { monthlyUsdLimit: 5 }, {} as typeof admin)).statusCode).toBe(401);
    expect((await env.app.inject({ url: "/admin/budgets", headers: { authorization: "Bearer rq_tenantA_secret" } })).statusCode).toBe(401);
  });

  it("PUT upserts; tenant sees the new limit; GET lists all", async () => {
    const res = await put("B", { monthlyUsdLimit: 5 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ tenant: "B", monthlyUsdLimit: 5 });
    expect((await env.get("/llm/usage", KEY_B)).json()).toMatchObject({ limitUsd: 5, remainingUsd: 1 });
    expect((await put("A", { monthlyUsdLimit: 2.5 })).statusCode).toBe(200);
    expect((await env.app.inject({ url: "/admin/budgets", headers: admin })).json()).toEqual([
      { tenant: "A", monthlyUsdLimit: 2.5 }, { tenant: "B", monthlyUsdLimit: 5 },
    ]);
  });

  it("invalid limit → 400", async () => {
    expect((await put("B", { monthlyUsdLimit: -1 })).statusCode).toBe(400);
    expect((await put("B", { monthlyUsdLimit: "5" })).statusCode).toBe(400);
    expect((await put("B", { monthlyUsdLimit: 2_000_000 })).statusCode).toBe(400);
  });
});
