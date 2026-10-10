import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { FastifyReply, FastifyRequest } from "fastify";

declare module "fastify" {
  interface FastifyRequest {
    tenant: string;
  }
}

export const hashKey = (key: string) => createHash("sha256").update(key).digest("hex");

export function authHook(prisma: PrismaClient) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const m = /^Bearer (rq_\S+)$/.exec(req.headers.authorization ?? "");
    const row = m && (await prisma.apiKey.findUnique({ where: { hash: hashKey(m[1]) } }));
    if (!row) return reply.code(401).send({ error: "unauthorized" });
    req.tenant = row.tenant;
  };
}
