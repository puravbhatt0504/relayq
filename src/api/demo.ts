import type { FastifyInstance } from "fastify";
import { enqueue } from "../outbox/enqueue.js";
import type { Deps } from "./server.js";

// Public demo (DEMO=1): no API key. Jobs only ever go to the built-in sink below, never to a
// visitor-supplied URL, so the demo can't be used to send requests anywhere else.
const TENANT = "demo";
const JOBS_PER_RUN = 100;
const RUN_COOLDOWN_S = 10;

const sink = { deliveries: 0, keys: new Set<string>(), failedOnce: new Set<string>() };

export function demoRoutes(app: FastifyInstance, { prisma, redis }: Deps) {
  app.get("/", (_req, reply) => reply.redirect("/demo"));
  app.get("/demo", (_req, reply) => reply.type("text/html").send(PAGE));

  app.post("/demo/run", async (_req, reply) => {
    if (!(await redis.set("demo:run-lock", "1", "EX", RUN_COOLDOWN_S, "NX"))) {
      return reply.code(429).send({ error: `one run per ${RUN_COOLDOWN_S}s, try again shortly` });
    }
    // Single-process hosts reach the sink on localhost; on ECS workers are separate tasks, so it's the ALB URL.
    const sinkUrl = process.env.DEMO_SINK_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3200}/demo/sink`;
    const run = Date.now();
    for (let i = 0; i < JOBS_PER_RUN; i += 20) {
      await Promise.all(Array.from({ length: 20 }, (_, k) => enqueue(prisma, {
        tenant: TENANT,
        type: "webhook.deliver",
        payload: { url: sinkUrl, body: { run, i: i + k, flaky: (i + k) % 5 === 0 } },
      })));
    }
    return reply.code(202).send({ enqueued: JOBS_PER_RUN });
  });

  // Every 5th job's first delivery gets a 503, so the page shows a retry with backoff.
  app.post<{ Body: { flaky?: boolean } }>("/demo/sink", async (req, reply) => {
    const key = String(req.headers["idempotency-key"] ?? "");
    sink.deliveries++;
    if (req.body?.flaky && !sink.failedOnce.has(key)) {
      sink.failedOnce.add(key);
      return reply.code(503).send("flaky on purpose");
    }
    if (sink.keys.size > 200_000) sink.keys.clear(); // bound memory on a long-lived demo
    sink.keys.add(key);
    return "ok";
  });

  app.get("/demo/stats", async () => {
    const [byStatus, recent] = await Promise.all([
      prisma.jobRecord.groupBy({ by: ["status"], where: { tenant: TENANT }, _count: true }),
      prisma.jobRecord.findMany({
        where: { tenant: TENANT }, orderBy: { updatedAt: "desc" }, take: 8,
        select: { id: true, status: true, attempts: true, error: true, updatedAt: true },
      }),
    ]);
    return {
      jobs: Object.fromEntries(byStatus.map((s) => [s.status, s._count])),
      sink: { deliveries: sink.deliveries, distinctKeys: sink.keys.size },
      recent,
    };
  });
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>RelayQ demo</title>
<style>
:root{--bg:#fafaf9;--fg:#1c1917;--muted:#78716c;--card:#fff;--line:#e7e5e4;--accent:#2563eb;--ok:#16a34a;--warn:#d97706;--bad:#dc2626}
@media (prefers-color-scheme:dark){:root{--bg:#0c0a09;--fg:#f5f5f4;--muted:#a8a29e;--card:#1c1917;--line:#292524;--accent:#60a5fa;--ok:#4ade80;--warn:#fbbf24;--bad:#f87171}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:860px;margin:0 auto;padding:32px 16px}h1{margin:0 0 4px;font-size:26px}p{color:var(--muted);margin:0 0 20px}
button{background:var(--accent);color:#fff;border:0;border-radius:8px;padding:10px 18px;font-size:15px;cursor:pointer}button:disabled{opacity:.5;cursor:default}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin:20px 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px}.card b{display:block;font-size:24px;font-variant-numeric:tabular-nums}.card span{color:var(--muted);font-size:13px}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden;font-size:13px}
td,th{padding:8px 10px;border-bottom:1px solid var(--line);text-align:left}th{color:var(--muted);font-weight:500}
.completed{color:var(--ok)}.failed,.active{color:var(--warn)}.dead{color:var(--bad)}code{font-size:12px}#msg{margin-left:12px;color:var(--muted)}
footer{margin-top:24px;color:var(--muted);font-size:13px}a{color:var(--accent)}
</style></head><body><main>
<h1>RelayQ</h1>
<p>Background-job service: HTTP enqueue through a transactional outbox, BullMQ workers, exponential-backoff retries, dead-letter queue, per-tenant rate limits. Press the button to enqueue 100 webhook jobs; every 5th delivery fails once on purpose so you can watch it retry.</p>
<button id="run">Run 100 jobs</button><span id="msg"></span>
<div class="grid" id="counts"></div>
<table><thead><tr><th>job</th><th>status</th><th>attempts</th><th>updated</th></tr></thead><tbody id="recent"></tbody></table>
<footer>Per-tenant limit is 100 jobs/min, so back-to-back runs queue up instead of being rejected. <a href="/health">/health</a> · <a href="/metrics">/metrics</a></footer>
</main><script>
const $=id=>document.getElementById(id);
const order=["pending","queued","active","failed","completed","dead"];
async function tick(){
  try{
    const s=await (await fetch("/demo/stats")).json();
    const cards=order.map(k=>'<div class="card"><b class="'+k+'">'+(s.jobs[k]||0)+'</b><span>'+k+'</span></div>');
    cards.push('<div class="card"><b>'+s.sink.deliveries+'</b><span>HTTP deliveries</span></div>');
    $("counts").innerHTML=cards.join("");
    $("recent").innerHTML=s.recent.map(j=>'<tr><td><code>'+j.id.slice(0,8)+'</code></td><td class="'+j.status+'">'+j.status+'</td><td>'+j.attempts+'</td><td>'+new Date(j.updatedAt).toLocaleTimeString()+'</td></tr>').join("");
  }catch(e){}
}
$("run").onclick=async()=>{
  $("run").disabled=true;
  const r=await fetch("/demo/run",{method:"POST"});
  $("msg").textContent=r.ok?"Enqueued 100 jobs":(await r.json()).error;
  setTimeout(()=>{$("run").disabled=false},3000);
};
tick();setInterval(tick,1000);
</script></body></html>`;
