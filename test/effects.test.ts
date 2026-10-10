import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { once } from "../src/lib/effects.js";
import { startEnv } from "./env.js";

let env: Awaited<ReturnType<typeof startEnv>>;

beforeAll(async () => { env = await startEnv({ relay: false }); });
afterAll(() => env?.stop());

describe("once()", () => {
  it("called twice runs fn once and replays the stored result", async () => {
    const fn = vi.fn(async () => ({ messageId: "m-1" }));
    expect(await once(env.prisma, "job-1", "send", fn)).toEqual({ messageId: "m-1" });
    expect(await once(env.prisma, "job-1", "send", fn)).toEqual({ messageId: "m-1" });
    expect(fn).toHaveBeenCalledTimes(1);
    // different step or job → runs
    await once(env.prisma, "job-1", "callback", fn);
    await once(env.prisma, "job-2", "send", fn);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("fn that throws records nothing, so the retry runs it again", async () => {
    let n = 0;
    const fn = async () => { if (++n === 1) throw new Error("SES down"); return n; };
    await expect(once(env.prisma, "job-3", "send", fn)).rejects.toThrow("SES down");
    expect(await once(env.prisma, "job-3", "send", fn)).toBe(2);
  });

  it("DB writes in fn commit atomically with the log entry", async () => {
    const { jobId } = (await env.post({ type: "webhook.deliver", payload: { url: "https://example.com/h", body: null } })).json();
    // The write happens, then fn fails → write rolled back with it.
    await expect(once(env.prisma, jobId, "note", async (tx) => {
      await tx.jobRecord.update({ where: { id: jobId }, data: { error: "written inside once" } });
      throw new Error("boom");
    })).rejects.toThrow("boom");
    expect((await env.prisma.jobRecord.findUniqueOrThrow({ where: { id: jobId } })).error).toBeNull();
    expect(await env.prisma.effectLog.count({ where: { jobId } })).toBe(0);
  });
});
