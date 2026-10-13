import type { FastifyInstance } from "fastify";
import type { Deps } from "../server.js";

// ponytail: the registry is shared by all tenants (one PulseBoard); scope rows by tenant if a second client trains models.
export function modelRoutes(app: FastifyInstance, { prisma }: Deps) {
  app.get<{ Params: { name: string } }>("/models/:name", async (req, reply) => {
    const rows = await prisma.modelVersion.findMany({ where: { name: req.params.name }, orderBy: { version: "desc" }, take: 100 });
    if (!rows.length) return reply.code(404).send({ error: "not found" });
    const history = rows.map(({ version, status, s3Uri, metrics, reason, createdAt }) => ({ version, status, s3Uri, metrics, reason, createdAt }));
    return { name: req.params.name, promoted: history.find((v) => v.status === "promoted") ?? null, history };
  });
}
