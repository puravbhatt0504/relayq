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
<title>RelayQ live demo</title>
<meta name="description" content="RelayQ is a background-job service: HTTP enqueue through a Postgres outbox, BullMQ workers, retries with backoff and per-tenant limits. Run 100 jobs and watch them live.">
<meta property="og:title" content="RelayQ live demo">
<meta property="og:description" content="Run 100 background jobs and watch them commit, retry and deliver in real time.">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%230b8a5f'/%3E%3Ctext x='16' y='22' font-family='Arial' font-weight='700' font-size='16' fill='%23fff' text-anchor='middle'%3ER%3C/text%3E%3C/svg%3E">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
/* Tokens. One cool-neutral family, one accent (emerald, also means "delivered").
   Radius rule: panels and tiles 14px, controls 8px, status chips 6px. */
:root{
  --bg:#f6f7f8;--surface:#fdfdfd;--sunken:#eef0f2;--line:#e2e5e9;--fg:#121417;--fg-2:#4a5059;--fg-3:#7c838d;
  --accent:#0b8a5f;--accent-ink:#fdfdfd;--accent-soft:#e3f4ec;
  --warn:#a8650b;--warn-soft:#fbefdc;--bad:#b4284a;--bad-soft:#fbe4ea;--idle:#9aa1ab;--busy:#4a5059;
  --shadow:0 1px 2px rgb(18 20 23 / .04),0 8px 28px -12px rgb(18 20 23 / .14);
  --font:"Geist",ui-sans-serif,system-ui,sans-serif;--mono:"Geist Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
  --ease:cubic-bezier(.16,1,.3,1);
}
@media (prefers-color-scheme:dark){:root{
  --bg:#0d0f11;--surface:#15181b;--sunken:#1b1f23;--line:#262b31;--fg:#eef0f2;--fg-2:#b3bac3;--fg-3:#7d8590;
  --accent:#3ccf91;--accent-ink:#06130d;--accent-soft:#12291f;
  --warn:#e3a54a;--warn-soft:#2a2012;--bad:#f0708e;--bad-soft:#2c1419;--idle:#59616b;--busy:#b3bac3;
  --shadow:0 1px 2px rgb(0 0 0 / .3),0 12px 32px -14px rgb(0 0 0 / .6);
}}
*{box-sizing:border-box}
html{scroll-behavior:smooth;-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 var(--font);-webkit-font-smoothing:antialiased}
a{color:inherit}
.wrap{max-width:1180px;margin:0 auto;padding:0 24px}
.mono{font-family:var(--mono);font-variant-numeric:tabular-nums}
.skip{position:absolute;left:-999px;top:8px;background:var(--fg);color:var(--bg);padding:8px 12px;border-radius:8px}
.skip:focus{left:8px}
:focus-visible{outline:2px solid var(--accent);outline-offset:3px;border-radius:4px}

/* Nav */
header{height:64px;display:flex;align-items:center;border-bottom:1px solid var(--line)}
header .wrap{display:flex;align-items:center;justify-content:space-between;width:100%}
.brand{font-weight:650;letter-spacing:-.02em;font-size:17px;text-decoration:none;display:flex;align-items:center;gap:10px}
.brand i{width:22px;height:22px;border-radius:6px;background:var(--accent);display:inline-block;position:relative}
.brand i::after{content:"";position:absolute;inset:6px 5px 6px 9px;border-left:2px solid var(--accent-ink);border-top:2px solid var(--accent-ink);transform:rotate(135deg)}
nav{display:flex;gap:28px;font-size:14px;color:var(--fg-2)}
nav a{text-decoration:none;transition:color .2s}nav a:hover{color:var(--fg)}

/* Hero */
.hero{display:grid;grid-template-columns:minmax(0,5fr) minmax(0,7fr);gap:56px;align-items:center;padding:72px 0 88px}
h1{font-size:clamp(36px,4.6vw,56px);line-height:1.04;letter-spacing:-.035em;font-weight:650;margin:0 0 20px;text-wrap:balance}
.lede{font-size:17px;color:var(--fg-2);max-width:42ch;margin:0 0 32px;text-wrap:pretty}
.ctas{display:flex;align-items:center;gap:24px;flex-wrap:wrap}
.btn{font:600 15px var(--font);background:var(--accent);color:var(--accent-ink);border:0;border-radius:8px;padding:12px 20px;cursor:pointer;white-space:nowrap;
  transition:transform .2s var(--ease),filter .2s,opacity .2s;display:inline-flex;align-items:center;gap:10px}
.btn:hover{filter:brightness(1.07)}.btn:active{transform:translateY(1px) scale(.98)}
.btn:disabled{opacity:.55;cursor:not-allowed;filter:none;transform:none}
.link{font-size:15px;font-weight:500;color:var(--fg-2);text-decoration:none;border-bottom:1px solid var(--line);padding-bottom:2px;transition:color .2s,border-color .2s}
.link:hover{color:var(--fg);border-color:var(--fg-3)}
.note{min-height:24px;margin:16px 0 0;font-size:14px;color:var(--fg-3)}
.note.ok{color:var(--accent)}.note.err{color:var(--bad)}

/* Live panel */
.panel{background:var(--surface);border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow);overflow:hidden}
.ph{display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid var(--line);font-size:13px;color:var(--fg-3)}
.live{display:inline-flex;align-items:center;gap:8px;color:var(--fg-2);font-weight:500}
.live b{width:7px;height:7px;border-radius:50%;background:var(--accent)}
.live.down b{background:var(--bad)}
.pb{padding:20px}
.bar{display:flex;height:10px;border-radius:6px;overflow:hidden;gap:2px;margin-bottom:20px}
.bar span{transition:flex-grow .6s var(--ease);min-width:0}
.counts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px 12px;margin-bottom:22px}
.count .n{font:500 26px/1.1 var(--mono);letter-spacing:-.02em;display:block;font-variant-numeric:tabular-nums}
.count .l{font-size:12.5px;color:var(--fg-3);display:flex;align-items:center;gap:7px;margin-top:4px}
.count .l i{width:8px;height:8px;border-radius:2px;display:inline-block}
.count .n.bump{animation:bump .5s var(--ease)}
@keyframes bump{from{transform:translateY(-3px);opacity:.55}to{transform:none;opacity:1}}
.spark{display:grid;grid-template-columns:auto 1fr;gap:16px;align-items:end;padding:14px 16px;background:var(--sunken);border-radius:10px;margin-bottom:20px}
.spark .rate{font:500 22px/1 var(--mono)}.spark .rate small{display:block;font:400 12px var(--font);color:var(--fg-3);margin-top:6px}
.spark svg{width:100%;height:44px;display:block}
.feed{list-style:none;margin:0;padding:0;display:grid;gap:2px}
.feed li{display:grid;grid-template-columns:88px 92px 1fr auto;align-items:center;gap:12px;padding:8px 10px;border-radius:8px;font-size:13px}
.feed li:nth-child(odd){background:var(--sunken)}
.feed li.enter{animation:enter .45s var(--ease)}
@keyframes enter{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
.feed .id{color:var(--fg-2)}.feed .t{color:var(--fg-3);text-align:right}.feed .a{color:var(--fg-3)}
.feed .a.retried{color:var(--warn)}
.chip{font:500 12px/1 var(--font);padding:5px 8px;border-radius:6px;justify-self:start}
.s-completed{color:var(--accent);background:var(--accent-soft)}
.s-failed{color:var(--warn);background:var(--warn-soft)}
.s-dead{color:var(--bad);background:var(--bad-soft)}
.s-active,.s-queued,.s-pending{color:var(--fg-2);background:var(--sunken)}
.feed li:nth-child(odd) .s-active,.feed li:nth-child(odd) .s-queued,.feed li:nth-child(odd) .s-pending{background:var(--surface)}
.empty{padding:28px 10px;text-align:center;color:var(--fg-3);font-size:14px}
.sk{background:var(--sunken);border-radius:6px;color:transparent!important;animation:pulse 1.4s ease-in-out infinite}
@keyframes pulse{50%{opacity:.55}}

/* Sections */
section{padding:88px 0;border-top:1px solid var(--line)}
h2{font-size:clamp(26px,3vw,36px);letter-spacing:-.03em;line-height:1.1;font-weight:650;margin:0 0 12px;text-wrap:balance}
.sub{color:var(--fg-2);max-width:60ch;margin:0 0 48px}
.flow{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:32px;counter-reset:s}
.flow div{border-top:2px solid var(--line);padding-top:20px;position:relative}
.flow div::before{content:"";position:absolute;top:-2px;left:0;width:40px;height:2px;background:var(--accent)}
.flow h3{font-size:17px;font-weight:600;letter-spacing:-.01em;margin:0 0 8px}
.flow p{margin:0;color:var(--fg-2);font-size:14.5px}
.flow code{font:13px var(--mono);color:var(--fg)}

.bento{display:grid;grid-template-columns:1.35fr 1fr 1fr;grid-template-rows:auto auto;gap:16px}
.tile{border-radius:14px;padding:28px;background:var(--surface);border:1px solid var(--line);display:flex;flex-direction:column;justify-content:space-between;gap:28px;min-height:180px}
.tile .big{font:500 clamp(34px,4vw,52px)/1 var(--mono);letter-spacing:-.04em}
.tile p{margin:0;color:var(--fg-2);font-size:14.5px;max-width:34ch}
.tile.hero-t{grid-row:span 2;background:var(--accent-soft);border-color:transparent}
.tile.hero-t .big{font-size:clamp(48px,6vw,84px);color:var(--accent)}
.tile.wide{grid-column:span 2;background:var(--sunken);border-color:transparent;flex-direction:row;align-items:flex-end}
.fine{margin:20px 0 0;font-size:13px;color:var(--fg-3)}

.types{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:48px}
.types h3{font-size:14px;font-weight:600;color:var(--fg-3);margin:0 0 16px}
.types dl{margin:0;display:grid;gap:20px}
.types dt{font:500 15px var(--mono);margin-bottom:4px}
.types dd{margin:0;color:var(--fg-2);font-size:14.5px;max-width:52ch}

footer{border-top:1px solid var(--line);padding:32px 0 48px;font-size:14px;color:var(--fg-3)}
footer .wrap{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap}
footer a{color:var(--fg-2);text-decoration:none}footer a:hover{color:var(--fg)}
footer nav{gap:24px}

/* Entry motion: hierarchy on load, then the panel. */
@media (prefers-reduced-motion:no-preference){
  .rise{animation:rise .8s var(--ease) both}
  .rise.d1{animation-delay:.06s}.rise.d2{animation-delay:.12s}.rise.d3{animation-delay:.2s}
  @keyframes rise{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}html{scroll-behavior:auto}}

@media (max-width:900px){
  .hero{grid-template-columns:1fr;gap:40px;padding:48px 0 64px}
  .flow{grid-template-columns:repeat(2,minmax(0,1fr))}
  .bento{grid-template-columns:1fr 1fr}.tile.hero-t{grid-row:auto;grid-column:span 2}.tile.wide{grid-column:span 2}
}
@media (max-width:640px){
  .wrap{padding:0 16px}nav.top{display:none}
  section{padding:64px 0}
  .flow,.types{grid-template-columns:1fr;gap:28px}
  .bento{grid-template-columns:1fr}.tile.hero-t,.tile.wide{grid-column:auto}.tile.wide{flex-direction:column;align-items:flex-start}
  .counts{grid-template-columns:repeat(2,minmax(0,1fr))}
  .feed li{grid-template-columns:72px 1fr auto;gap:8px}.feed .a{display:none}
}
</style></head><body>
<a class="skip" href="#main">Skip to content</a>
<header><div class="wrap">
  <a class="brand" href="/demo" aria-label="RelayQ home"><i aria-hidden="true"></i>RelayQ</a>
  <nav class="top" aria-label="Sections"><a href="#how">How it works</a><a href="#numbers">Numbers</a><a href="#types">Job types</a><a href="https://github.com/puravbhatt0504/relayq">Source</a></nav>
</div></header>

<main id="main">
<div class="wrap">
  <div class="hero">
    <div>
      <h1 class="rise">Background jobs that survive crashes.</h1>
      <p class="lede rise d1">Send a job over HTTP. RelayQ commits it to Postgres first, then delivers it with retries, backoff and per-tenant limits.</p>
      <div class="ctas rise d2">
        <button class="btn" id="run" type="button">Run 100 jobs</button>
        <a class="link" href="https://github.com/puravbhatt0504/relayq">Read the source</a>
      </div>
      <p class="note rise d2" id="msg" role="status" aria-live="polite">Every fifth delivery fails once on purpose, so you can watch it retry.</p>
    </div>

    <div class="panel rise d3" aria-label="Live queue for the demo tenant">
      <div class="ph"><span class="live" id="live"><b aria-hidden="true"></b><span id="liveText">Connecting</span></span><span class="mono">tenant: demo</span></div>
      <div class="pb">
        <div class="bar" id="bar" aria-hidden="true"><span class="sk" style="flex-grow:1"></span></div>
        <div class="counts" id="counts"></div>
        <div class="spark">
          <div class="rate"><span id="rate">0</span><small>deliveries / s</small></div>
          <svg viewBox="0 0 300 44" preserveAspectRatio="none" aria-label="Deliveries per second, last 60 seconds" role="img">
            <path id="area" fill="var(--accent-soft)" d=""/><path id="line" fill="none" stroke="var(--accent)" stroke-width="1.6" vector-effect="non-scaling-stroke" d=""/>
          </svg>
        </div>
        <ul class="feed" id="feed" aria-label="Most recently updated jobs"></ul>
      </div>
    </div>
  </div>
</div>

<section id="how"><div class="wrap">
  <h2>What happens when you press the button</h2>
  <p class="sub">The same path every API client takes. Nothing on this page is simulated except the sink that fails on purpose.</p>
  <div class="flow">
    <div><h3>Commit</h3><p><code>POST /jobs</code> writes the job and an outbox row in one Postgres transaction. A 202 means it is on disk.</p></div>
    <div><h3>Relay</h3><p>A relay moves committed rows into Redis with <code>SKIP LOCKED</code>, so several relays never publish a row twice.</p></div>
    <div><h3>Deliver</h3><p>A BullMQ worker sends a signed webhook with an idempotency key that stays the same on every retry.</p></div>
    <div><h3>Retry</h3><p>Failures back off exponentially. After five attempts the job lands in a dead-letter queue for a manual retry.</p></div>
  </div>
</div></section>

<section id="numbers"><div class="wrap">
  <h2>Measured, with the test that proves it</h2>
  <p class="sub">Each number comes from a load test or a test in the repo, not from a slide.</p>
  <div class="bento">
    <div class="tile hero-t"><span class="big">33,424</span><p>jobs per minute completed in a 5 minute k6 run, with workers keeping pace the whole time.</p></div>
    <div class="tile"><span class="big">0 lost</span><p>167,133 jobs enqueued, 167,133 completed.</p></div>
    <div class="tile"><span class="big">130.6 ms</span><p>p95 enqueue latency under that load.</p></div>
    <div class="tile wide"><span class="big">10,000</span><p>jobs in the chaos test while a worker is SIGKILLed every 3 seconds and the API once. None lost, and the receiver saw exactly 10,000 distinct jobs.</p></div>
  </div>
  <p class="fine">Docker Compose on one laptop: 3 workers with 5 concurrent jobs each, Postgres 16, Redis 7.</p>
</div></section>

<section id="types"><div class="wrap">
  <h2>Six job types, one queue</h2>
  <p class="sub">Each type has its own queue, concurrency and limits. AI jobs add token budgets and batching on top.</p>
  <div class="types">
    <div><h3>Delivery</h3><dl>
      <div><dt>webhook.deliver</dt><dd>Signed POST to a tenant URL. Private and cloud-metadata addresses are refused.</dd></div>
      <div><dt>email.digest</dt><dd>Renders a digest and sends it through SES, capped at the SES sending rate.</dd></div>
      <div><dt>board.export</dt><dd>Builds a CSV or JSON export and calls back with a download link.</dd></div>
    </dl></div>
    <div><h3>AI workloads</h3><dl>
      <div><dt>embed.batch</dt><dd>Merges small jobs into shared provider calls: 300 jobs go out in at most 4 requests.</dd></div>
      <div><dt>llm.complete</dt><dd>Reserves the estimated cost against the tenant's monthly budget, then falls back to a second model when the first is overloaded.</dd></div>
      <div><dt>ml.retrain</dt><dd>Trains a new model and promotes it only if its test error beats the current one.</dd></div>
    </dl></div>
  </div>
</div></section>
</main>

<footer><div class="wrap">
  <span>RelayQ, built by Purav Bhatt</span>
  <nav aria-label="Footer"><a href="https://github.com/puravbhatt0504/relayq">GitHub</a><a href="/health">Health</a></nav>
</div></footer>

<script>
(function(){
  var $=function(id){return document.getElementById(id)};
  var reduce=matchMedia("(prefers-reduced-motion: reduce)").matches;
  // Status order and labels: "failed" means an attempt failed and a retry is scheduled.
  var KINDS=[["completed","delivered","var(--accent)"],["queued","queued","var(--idle)"],["active","running","var(--busy)"],
             ["failed","retrying","var(--warn)"],["dead","dead letter","var(--bad)"],["pending","committed","var(--idle)"]];
  var LABEL={};KINDS.forEach(function(k){LABEL[k[0]]=k[1]});
  var last={},seen={},hist=[],prev=null,first=true;

  function esc(s){return String(s).replace(/[&<>"]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]})}
  function fmt(n){return n.toLocaleString("en-US")}
  function ago(t){var s=Math.max(0,Math.round((Date.now()-new Date(t))/1000));return s<60?s+"s ago":Math.round(s/60)+"m ago"}

  // Skeleton until the first stats arrive.
  $("counts").innerHTML=KINDS.slice(0,5).concat([["x","x"]]).map(function(){return '<div class="count"><span class="n sk">0000</span><span class="l sk">loading</span></div>'}).join("");
  $("feed").innerHTML=[0,1,2,3].map(function(){return '<li><span class="sk">id</span><span class="sk">status</span><span></span><span></span></li>'}).join("");

  function counts(s){
    var cells=KINDS.slice(0,5).map(function(k){return {key:k[0],label:k[1],color:k[2],n:s.jobs[k[0]]||0}});
    cells.push({key:"http",label:"HTTP deliveries",color:"",n:s.sink.deliveries});
    $("counts").innerHTML=cells.map(function(c){
      var bump=!first&&last[c.key]!==c.n&&!reduce?" bump":"";last[c.key]=c.n;
      return '<div class="count"><span class="n'+bump+'">'+fmt(c.n)+'</span><span class="l">'+(c.color?'<i style="background:'+c.color+'"></i>':'')+c.label+'</span></div>';
    }).join("");
    var total=KINDS.reduce(function(t,k){return t+(s.jobs[k[0]]||0)},0);
    $("bar").innerHTML=total?KINDS.filter(function(k){return s.jobs[k[0]]}).map(function(k){
      return '<span title="'+k[1]+'" style="flex-grow:'+s.jobs[k[0]]+';background:'+k[2]+'"></span>'}).join(""):'<span style="flex-grow:1;background:var(--sunken)"></span>';
  }

  function spark(s){
    var now=Date.now();
    if(prev){var dt=(now-prev.t)/1000;hist.push(Math.max(0,(s.sink.deliveries-prev.d)/dt))}
    prev={t:now,d:s.sink.deliveries};
    if(hist.length>60)hist.shift();
    var r=hist.length?hist[hist.length-1]:0;$("rate").textContent=r<10?r.toFixed(1):Math.round(r);
    var max=Math.max(5,Math.max.apply(null,hist.concat([0]))),n=60,pts=[];
    for(var i=0;i<hist.length;i++){pts.push([(300*(n-hist.length+i))/(n-1),42-(hist[i]/max)*38])}
    if(pts.length<2){$("line").setAttribute("d","");$("area").setAttribute("d","");return}
    var d="M"+pts.map(function(p){return p[0].toFixed(1)+" "+p[1].toFixed(1)}).join(" L");
    $("line").setAttribute("d",d);
    $("area").setAttribute("d",d+" L"+pts[pts.length-1][0].toFixed(1)+" 44 L"+pts[0][0].toFixed(1)+" 44 Z");
  }

  function feed(s){
    if(!s.recent.length){$("feed").innerHTML='<li class="empty" style="display:block">No jobs yet. Run a batch and they will show up here as they move.</li>';return}
    $("feed").innerHTML=s.recent.map(function(j){
      var fresh=!first&&!seen[j.id+j.status]?" enter":"";seen[j.id+j.status]=1;
      var a=j.attempts>1?'<span class="a retried">retried, '+j.attempts+' attempts</span>':'<span class="a">'+j.attempts+' attempt'+(j.attempts===1?"":"s")+'</span>';
      return '<li class="'+fresh+'"><span class="id mono">'+esc(j.id.slice(0,8))+'</span><span class="chip s-'+esc(j.status)+'">'+esc(LABEL[j.status]||j.status)+'</span>'+a+'<span class="t mono">'+ago(j.updatedAt)+'</span></li>';
    }).join("");
  }

  function tick(){
    fetch("/demo/stats").then(function(r){if(!r.ok)throw r;return r.json()}).then(function(s){
      $("live").className="live";$("liveText").textContent="Live";
      counts(s);spark(s);feed(s);first=false;
    }).catch(function(){
      $("live").className="live down";$("liveText").textContent="Can't reach the API, retrying";
    });
  }

  var btn=$("run"),msg=$("msg");
  function cooldown(sec){
    btn.disabled=true;var left=sec;
    var t=setInterval(function(){left--;btn.textContent=left>0?"Run again in "+left+"s":"Run 100 jobs";if(left<=0){clearInterval(t);btn.disabled=false}},1000);
    btn.textContent="Run again in "+left+"s";
  }
  btn.addEventListener("click",function(){
    btn.disabled=true;
    fetch("/demo/run",{method:"POST"}).then(function(r){return r.json().then(function(b){return{ok:r.ok,b:b}})}).then(function(x){
      if(x.ok){msg.className="note ok";msg.textContent="100 jobs enqueued. Watch the retrying ones turn into deliveries.";cooldown(10)}
      else{msg.className="note err";msg.textContent="Another run just started. "+(x.b.error||"Try again in a few seconds.");cooldown(5)}
    }).catch(function(){msg.className="note err";msg.textContent="Couldn't reach the API. Check your connection and try again.";btn.disabled=false});
  });

  tick();setInterval(tick,1000);
})();
</script>
</body></html>`;
