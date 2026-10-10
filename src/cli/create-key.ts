// Usage: npm run key -- <tenant>   → prints a new rq_ key once; only its sha256 is stored.
import { PrismaClient } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { hashKey } from "../api/auth.js";

const tenant = process.argv[2];
if (!tenant) {
  console.error("usage: create-key <tenant>");
  process.exit(1);
}
const key = `rq_${randomBytes(24).toString("base64url")}`;
const prisma = new PrismaClient();
await prisma.apiKey.create({ data: { hash: hashKey(key), tenant } });
await prisma.$disconnect();
console.log(key);
