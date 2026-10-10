import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { relayOnce } from "../src/outbox/relay.js";
import type { Queues } from "../src/queue/queues.js";
import { startEnv } from "./env.js";

let env: Awaited<ReturnType<typeof startEnv>>;
const hook = { type: "webhook.deliver", payload: { url: "https://example.com/h", body: null } };

beforeAll(async () => { env = await startEnv({ relay: false }); });
afterAll(() => env?.stop());

/** Same queues, but addBulk records every jobId it's handed (and can be told to blow up after publishing). */
function spyQueues(published: string[], failAfterPublish = { n: 0 }): Queues {
  const q = env.queues["webhook.deliver"];
  const spied = Object.create(q) as typeof q;
  spied.addBulk = async (jobs) => {
    const res = await q.addBulk(jobs);
    published.push(...jobs.map((j) => j.opts!.jobId!));
    if (failAfterPublish.n-- > 0) throw new Error("crash between publish and commit");
    return res;
  };
  return { ...env.queues, "webhook.deliver": spied };
}

async function enqueue(n: number) {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) ids.push((await env.post(hook)).json().jobId);
  return ids;
}

describe("outbox relay", () => {
  it("commit without relay → nothing in Redis, row waits in the outbox", async () => {
    const [id] = await enqueue(1);
    expect(await env.queues["webhook.deliver"].getJob(id)).toBeFalsy();
    expect(await env.prisma.jobRecord.findUnique({ where: { id } })).toMatchObject({ status: "pending" });
    await relayOnce(env.prisma, env.queues);
    expect(await env.queues["webhook.deliver"].getJob(id)).toBeTruthy();
    expect(await env.prisma.jobRecord.findUnique({ where: { id } })).toMatchObject({ status: "queued" });
  });

  it("two relays on the same table never publish a row twice", async () => {
    const ids = await enqueue(500);
    const published: string[] = [];
    const queues = spyQueues(published);
    const drain = async () => { while ((await relayOnce(env.prisma, queues)) > 0); };
    await Promise.all([drain(), drain()]);

    expect(published).toHaveLength(500);
    expect(new Set(published)).toEqual(new Set(ids));
    expect(await env.prisma.outbox.count({ where: { publishedAt: null } })).toBe(0);
    expect(await env.prisma.jobRecord.count({ where: { id: { in: ids }, status: "queued" } })).toBe(500);
  });

  it("crash after publishing but before commit → rows re-published, BullMQ still holds one job each", async () => {
    const q = env.queues["webhook.deliver"];
    await q.obliterate({ force: true });
    const ids = await enqueue(20);
    const published: string[] = [];
    await expect(relayOnce(env.prisma, spyQueues(published, { n: 1 }))).rejects.toThrow("crash");
    expect(await env.prisma.outbox.count({ where: { publishedAt: null } })).toBe(20); // rolled back

    await relayOnce(env.prisma, spyQueues(published));
    expect(published).toHaveLength(40); // every row published twice…
    expect(await q.count()).toBe(20); // …but one job per id
    expect((await Promise.all(ids.map((id) => q.getJob(id)))).every(Boolean)).toBe(true);
  });
});
