import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KEY_B, startEnv } from "./env.js";

const webhook = { type: "webhook.deliver", payload: { url: "https://example.com/hook", body: { hi: 1 } } };
let env: Awaited<ReturnType<typeof startEnv>>;

beforeAll(async () => { env = await startEnv(); });
afterAll(() => env?.stop());

describe("POST /jobs", () => {
  it("202 on valid job, and writes JobRecord", async () => {
    const res = await env.post(webhook);
    expect(res.statusCode).toBe(202);
    const { jobId, status } = res.json();
    expect(status).toBe("queued");
    expect(await env.prisma.jobRecord.findUnique({ where: { id: jobId } })).toMatchObject({ tenant: "A", status: "queued" });
  });

  it("400 on unknown type", async () => {
    expect((await env.post({ type: "nope", payload: {} })).statusCode).toBe(400);
    expect((await env.post({ type: "dead", payload: {} })).statusCode).toBe(400);
  });

  it("400 {errors} on bad payload", async () => {
    const res = await env.post({ type: "email.digest", payload: { to: "not-an-email", userName: "x", items: [] } });
    expect(res.statusCode).toBe(400);
    expect(res.json().errors[0].path).toEqual(["to"]);
  });

  it("401 with no key or unknown key", async () => {
    expect((await env.app.inject({ method: "POST", url: "/jobs", payload: webhook })).statusCode).toBe(401);
    expect((await env.post(webhook, "rq_unknown")).statusCode).toBe(401);
  });

  it("duplicate idempotencyKey returns original jobId and enqueues once", async () => {
    const q = env.queues["email.digest"];
    await q.obliterate({ force: true });
    const job = { type: "email.digest", payload: { to: "a@b.co", userName: "Ann", items: [] }, idempotencyKey: "k1" };
    const first = await env.post(job);
    const second = await env.post(job);
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(200);
    expect(second.json().jobId).toBe(first.json().jobId);
    expect(await q.count()).toBe(1);
    // same key, other tenant → independent job
    expect((await env.post(job, KEY_B)).statusCode).toBe(202);
  });
});

describe("GET /jobs/:id", () => {
  it("returns own job; other tenant gets 404", async () => {
    const { jobId } = (await env.post(webhook)).json();
    const own = await env.get(`/jobs/${jobId}`);
    expect(own.statusCode).toBe(200);
    expect(own.json()).toMatchObject({ id: jobId, type: "webhook.deliver", status: "queued", attempts: 0 });
    expect((await env.get(`/jobs/${jobId}`, KEY_B)).statusCode).toBe(404);
  });
});
