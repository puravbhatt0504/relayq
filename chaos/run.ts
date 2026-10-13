// npm run chaos — 10,000 webhook jobs while a random worker is SIGKILLed every 3 s and the api once.
// Pass: every job completed, sink saw exactly 10,000 distinct Idempotency-Keys, outbox fully drained.
import { execFileSync } from "node:child_process";

const JOBS = Number(process.env.CHAOS_JOBS ?? 10_000);
const API = "http://localhost:3200";
const SINK = "http://localhost:5679";
const tenant = `chaos-${Date.now()}`;
const env = { ...process.env, TENANT_JOBS_PER_MIN: "1000000" };

const sh = (cmd: string, args: string[]) => execFileSync(cmd, args, { env, encoding: "utf8" }).trim();
const compose = (...args: string[]) => sh("docker", ["compose", "--profile", "chaos", ...args]);
const sql = (q: string) => compose("exec", "-T", "postgres", "psql", "-U", "relayq", "-tAc", q);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...a: unknown[]) => console.log(`[chaos ${new Date().toISOString().slice(11, 19)}]`, ...a);

async function until(what: string, ok: () => Promise<boolean> | boolean, ms = 600_000) {
  const end = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(1000);
  }
}
const healthy = () => fetch(`${API}/health`).then((r) => r.ok, () => false);

log("starting stack");
compose("up", "-d", "--build", "--wait", "api", "worker", "chaos-sink");
await until("api health", healthy, 120_000);
const key = compose("exec", "-T", "api", "node", "dist/cli/create-key.js", tenant);
await fetch(`${SINK}/reset`, { method: "POST" });

// Killer: SIGKILL a random worker every 3 s and bring it back; kill the api once at the halfway mark.
let enqueued = 0;
let workerKills = 0;
let apiKilled = false;
let killing = true;
const killer = (async () => {
  while (killing) {
    await sleep(3000);
    if (!killing) break;
    const ids = compose("ps", "-q", "worker").split(/\s+/).filter(Boolean);
    const victim = ids[Math.floor(Math.random() * ids.length)];
    sh("docker", ["kill", victim]);
    sh("docker", ["start", victim]);
    workerKills++;
    if (!apiKilled && enqueued >= JOBS / 2) {
      apiKilled = true;
      const api = compose("ps", "-q", "api");
      log(`killing api at ${enqueued} enqueued`);
      sh("docker", ["kill", api]);
      sh("docker", ["start", api]);
    }
  }
})();

// Enqueue with a per-job idempotency key, retrying through api downtime: retries can't double-enqueue.
const jobIds = new Set<string>();
const t0 = Date.now();
let next = 0;
async function client() {
  while (next < JOBS) {
    const i = next++;
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(`${API}/jobs`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body: JSON.stringify({ type: "webhook.deliver", idempotencyKey: `${tenant}-${i}`, payload: { url: "http://chaos-sink:5679/", body: { i } } }),
          signal: AbortSignal.timeout(5000),
        });
        if (res.status === 202 || res.status === 200) {
          jobIds.add((await res.json()).jobId);
          enqueued++;
          break;
        }
        if (res.status < 500) throw new Error(`enqueue ${i} rejected: ${res.status} ${await res.text()}`);
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("enqueue")) throw err;
      }
      await sleep(Math.min(200 * 2 ** attempt, 3000)); // api down / restarting
    }
  }
}
await Promise.all(Array.from({ length: 50 }, client));
log(`enqueued ${enqueued} (${jobIds.size} distinct ids) in ${((Date.now() - t0) / 1000).toFixed(1)}s, ${workerKills} worker kills so far`);

killing = false;
await killer;
compose("up", "-d", "--wait", "api", "worker"); // make sure everything is back up
log(`killer stopped: ${workerKills} worker kills, api killed: ${apiKilled}; draining`);

const counts = () => Object.fromEntries(
  sql(`select status, count(*) from "JobRecord" where tenant='${tenant}' group by 1`)
    .split("\n").filter(Boolean).map((l) => l.split("|")).map(([s, n]) => [s, Number(n)]),
) as Record<string, number>;
await until("all jobs completed or dead", () => {
  const c = counts();
  return (c.completed ?? 0) + (c.dead ?? 0) === JOBS;
});

const c = counts();
const sink = (await (await fetch(`${SINK}/stats`)).json()) as { deliveries: number; distinct: number };
const unpublished = Number(sql(`select count(*) from "Outbox" o join "JobRecord" j on j.id = o."jobId" where j.tenant='${tenant}' and o."publishedAt" is null`));
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

const checks: [string, boolean][] = [
  [`${JOBS} distinct job ids enqueued (got ${jobIds.size})`, jobIds.size === JOBS],
  [`every job completed (completed=${c.completed ?? 0}, dead=${c.dead ?? 0})`, c.completed === JOBS],
  [`sink saw ${JOBS} distinct Idempotency-Keys (got ${sink.distinct})`, sink.distinct === JOBS],
  [`outbox drained (unpublished=${unpublished})`, unpublished === 0],
];
console.log(`\nchaos run: ${JOBS} jobs, ${workerKills} worker SIGKILLs, api killed once: ${apiKilled}, ${elapsed}s total`);
console.log(`sink: ${sink.deliveries} HTTP deliveries, ${sink.distinct} distinct keys (${sink.deliveries - sink.distinct} transport-level redeliveries deduped by key)`);
for (const [name, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
