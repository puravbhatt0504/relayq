import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startWorkers } from "../src/worker/index.js";
import { KEY_B, startEnv, waitFor } from "./env.js";

let env: Awaited<ReturnType<typeof startEnv>>;
const hook = (priority?: number) => ({ type: "webhook.deliver", payload: { url: "https://example.com/h", body: null }, priority });
const starts: { id: string; t: number }[] = [];

function workersWith(opts: Partial<Parameters<typeof startWorkers>[0]>) {
  return startWorkers({
    connection: env.connection,
    prisma: env.prisma,
    dead: env.queues.dead,
    handlers: {
      "email.digest": async () => ({}),
      "board.export": async () => ({}),
      "webhook.deliver": async (_d, { jobId }) => { starts.push({ id: jobId, t: Date.now() }); return {}; },
    },
    ...opts,
  });
}

beforeAll(async () => { env = await startEnv(); });
afterAll(() => env?.stop());

describe("per-tenant rate limit", () => {
  // Scaled-down window: 10 jobs / 3 s stands in for 100 jobs / 60 s. 3 s, not 1 s: the window opens at the limiter
  // check, and on a loaded machine (full suite, CI) the first handler can start over a second later. Measuring the
  // first window from that start (t0) stays correct as long as the lag is under 3 s − 900 ms.
  it("300 jobs at 10 per window: ≤10 start in the first window, excess stays queued, other tenants unaffected", async () => {
    const ids: string[] = (await Promise.all(Array.from({ length: 300 }, () => env.post(hook())))).map((r) => r.json().jobId);
    const { jobId: other } = (await env.post(hook(), KEY_B)).json();
    await env.drained(); // everything in Redis before any worker starts
    const w = workersWith({ tenantLimit: { max: 10, windowMs: 3000 } });
    try {
      // Tenant B isn't stuck behind A's backlog.
      await waitFor(async () => starts.some((s) => s.id === other), 5000);

      const aStarts = () => starts.filter((s) => s.id !== other);
      const t0 = await waitFor(async () => aStarts()[0]?.t);
      await new Promise((r) => setTimeout(r, t0 + 6500 - Date.now()));

      const first = aStarts().filter((s) => s.t < t0 + 900).length;
      expect(first).toBeGreaterThanOrEqual(1);
      expect(first).toBeLessThanOrEqual(10);
      const done = aStarts().length;
      expect(done).toBeGreaterThanOrEqual(20); // later windows keep draining
      expect(done).toBeLessThanOrEqual(30); // windows open at ≤ t0, +3 s, +6 s: at most 3 in 6.5 s

      const recs = await env.prisma.jobRecord.findMany({ where: { id: { in: ids } } });
      const count = (st: string) => recs.filter((r) => r.status === st).length;
      expect(count("queued")).toBeGreaterThan(200); // excess waits, not rejected
      expect(count("dead") + count("failed")).toBe(0);
      // A throttled job that ran in a later window used one attempt, not one per throttle.
      const late = aStarts().at(-1)!.id;
      expect(recs.find((r) => r.id === late)).toMatchObject({ status: "completed", attempts: 1 });
    } finally {
      // Clean up even on failure so the priority test below starts from an empty queue.
      await w.close();
      await env.queues["webhook.deliver"].obliterate({ force: true });
      await env.prisma.jobRecord.deleteMany();
      starts.length = 0;
    }
  }, 30_000);
});

describe("priority", () => {
  it("priority-1 job enqueued after 50 priority-5 jobs completes before them", async () => {
    const p5 = [];
    for (let i = 0; i < 50; i++) p5.push((await env.post(hook())).json().jobId);
    const { jobId: p1 } = (await env.post(hook(1))).json();
    await env.drained();

    starts.length = 0;
    const w = workersWith({ concurrency: 1, tenantLimit: { max: 1000, windowMs: 1000 } });
    await waitFor(async () => starts.length === 51);
    await w.close();
    expect(starts[0].id).toBe(p1);
    expect(starts.slice(1).map((s) => s.id)).toEqual(p5); // FIFO within a priority
  });

  it("priority outside 1..10 → 400", async () => {
    expect((await env.post(hook(0))).statusCode).toBe(400);
    expect((await env.post(hook(11))).statusCode).toBe(400);
  });
});

describe("enqueue cap", () => {
  it("> 10,000 queued jobs for one tenant → 429; other tenants unaffected", async () => {
    await env.prisma.jobRecord.createMany({
      data: Array.from({ length: 10_000 }, (_, i) => ({ id: `fill-${i}`, tenant: "B", type: "webhook.deliver", payload: {} })),
    });
    expect((await env.post(hook(), KEY_B)).statusCode).toBe(429);
    expect((await env.post(hook())).statusCode).toBe(202);
  });
});
