import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEnv } from "./env.js";

let env: Awaited<ReturnType<typeof startEnv>>;
let provider: Server;
let mode: "ok" | "429" | "500" = "ok";
const calls: { input: string[]; model: string }[] = [];

beforeAll(async () => {
  provider = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c)).on("end", () => {
      const b = JSON.parse(raw);
      calls.push(b);
      if (mode === "429") return res.writeHead(429, { "retry-after": "3" }).end();
      if (mode === "500") return res.writeHead(500).end();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: b.input.map((t: string, index: number) => ({ index, embedding: [t.length, index] })).reverse() }));
    });
  }).listen(0);
  process.env.VOYAGE_BASE_URL = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
  process.env.VOYAGE_API_KEY = "test";
  env = await startEnv({ relay: false });
});
afterAll(async () => {
  provider.close();
  await env?.stop();
});

const embed = (payload: unknown, headers: Record<string, string> = { authorization: "Bearer rq_tenantA_secret" }) =>
  env.app.inject({ method: "POST", url: "/embed", headers, payload: payload as object });

describe("POST /embed", () => {
  it("returns one vector per text, in input order, from one provider call", async () => {
    const res = await embed({ texts: ["ab", "abcd"] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ model: "voyage-3.5", embeddings: [[2, 0], [4, 1]] });
    expect(calls.at(-1)).toEqual({ input: ["ab", "abcd"], model: "voyage-3.5" });
  });

  it("needs a tenant key; validates input", async () => {
    expect((await embed({ texts: ["x"] }, {})).statusCode).toBe(401);
    expect((await embed({ texts: [] })).statusCode).toBe(400);
    expect((await embed({ texts: Array(17).fill("x") })).statusCode).toBe(400);
  });

  it("provider 429 → 429 with retry-after; provider down → 503", async () => {
    mode = "429";
    const limited = await embed({ texts: ["x"] });
    expect([limited.statusCode, limited.headers["retry-after"]]).toEqual([429, "3"]);
    mode = "500";
    expect((await embed({ texts: ["x"] })).statusCode).toBe(503);
    mode = "ok";
  });
});
