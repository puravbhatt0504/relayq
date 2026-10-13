import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Deps } from "../server.js";

const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const usd = (n: unknown) => Math.round(Number(n ?? 0) * 1e6) / 1e6;

async function limitFor(prisma: Deps["prisma"], tenant: string) {
  const row = await prisma.tenantBudget.findUnique({ where: { tenant } });
  return row ? Number(row.monthlyUsdLimit) : Number(process.env.LLM_DEFAULT_MONTHLY_USD ?? 0);
}

/** Tenant view of its own LLM spend (settled ledger rows, not open reservations). */
export function llmUsageRoutes(app: FastifyInstance, { prisma }: Deps) {
  app.get<{ Querystring: { month?: string } }>("/llm/usage", async (req, reply) => {
    const m = month.safeParse(req.query.month ?? new Date().toISOString().slice(0, 7));
    if (!m.success) return reply.code(400).send({ error: "month must be YYYY-MM" });
    const from = new Date(`${m.data}-01T00:00:00Z`);
    const to = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));
    const rows = await prisma.llmUsage.groupBy({
      by: ["model"],
      where: { tenant: req.tenant, createdAt: { gte: from, lt: to } },
      _count: { _all: true },
      _sum: { inputTokens: true, outputTokens: true, cacheWriteTokens: true, cacheReadTokens: true, costUsd: true },
    });
    const byModel = rows
      .map((r) => ({
        model: r.model, calls: r._count._all,
        inputTokens: r._sum.inputTokens ?? 0, outputTokens: r._sum.outputTokens ?? 0,
        cacheWriteTokens: r._sum.cacheWriteTokens ?? 0, cacheReadTokens: r._sum.cacheReadTokens ?? 0,
        costUsd: usd(r._sum.costUsd),
      }))
      .sort((a, b) => b.costUsd - a.costUsd);
    const spentUsd = usd(byModel.reduce((s, r) => s + r.costUsd, 0));
    const limitUsd = await limitFor(prisma, req.tenant);
    return { month: m.data, limitUsd, spentUsd, remainingUsd: usd(Math.max(0, limitUsd - spentUsd)), byModel };
  });
}

const budgetBody = z.object({ monthlyUsdLimit: z.number().min(0).max(1_000_000) });

/** Operator-only: set and list per-tenant monthly LLM limits (registered under admin basic auth). */
export function budgetAdminRoutes(app: FastifyInstance, { prisma }: Deps) {
  app.get("/admin/budgets", async () =>
    (await prisma.tenantBudget.findMany({ orderBy: { tenant: "asc" } })).map((b) => ({ tenant: b.tenant, monthlyUsdLimit: Number(b.monthlyUsdLimit) })));

  app.put<{ Params: { tenant: string } }>("/admin/budgets/:tenant", async (req, reply) => {
    const b = budgetBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ errors: b.error.issues });
    const { tenant } = req.params;
    const row = await prisma.tenantBudget.upsert({ where: { tenant }, create: { tenant, ...b.data }, update: b.data });
    return { tenant, monthlyUsdLimit: Number(row.monthlyUsdLimit) };
  });
}
