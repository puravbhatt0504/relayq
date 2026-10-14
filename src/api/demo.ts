import { readFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { enqueue } from "../outbox/enqueue.js";
import type { Deps } from "./server.js";

// Public demo (DEMO=1): no API key. Jobs only ever go to the built-in sink below, never to a
// visitor-supplied URL, so the demo can't be used to send requests anywhere else.
const TENANT = "demo";
const JOBS_PER_RUN = 100;
const RUN_COOLDOWN_S = 10;

const sink = { deliveries: 0, keys: new Set<string>(), failedOnce: new Set<string>() };

// Scene files for the demo page (models, textures, the hill script). Only these types, only from this folder.
const ASSETS = path.resolve(process.cwd(), "public/demo/assets");
const ASSET_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8", ".glb": "model/gltf-binary", ".gltf": "model/gltf+json",
  ".bin": "application/octet-stream", ".hdr": "application/octet-stream", ".jpg": "image/jpeg",
};

export function demoRoutes(app: FastifyInstance, { prisma, redis }: Deps) {
  app.get("/", (_req, reply) => reply.redirect("/demo"));
  app.get("/demo", (_req, reply) => reply.type("text/html").send(PAGE));

  app.get<{ Params: { "*": string } }>("/demo/assets/*", async (req, reply) => {
    const file = path.resolve(ASSETS, req.params["*"]);
    const type = ASSET_TYPES[path.extname(file)];
    if (!type || !file.startsWith(ASSETS + path.sep)) return reply.code(404).send();
    const body = await readFile(file).catch(() => null);
    if (!body) return reply.code(404).send();
    return reply.type(type).header("cache-control", "public, max-age=86400").send(body);
  });

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
<meta name="description" content="RelayQ is a background-job queue that keeps pushing until every job lands. Send 100 real jobs and watch them as boulders on a hill: slips roll back, workers push again.">
<meta property="og:title" content="RelayQ live demo">
<meta property="og:description" content="Sisyphus, with retries. Send 100 real jobs and watch every one of them make it up the hill.">
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
  --hill:#d3d9df;--rock:#a3aab3;--figure:#2b3036;
  --shadow:0 1px 2px rgb(18 20 23 / .04),0 8px 28px -12px rgb(18 20 23 / .14);
  --font:"Geist",ui-sans-serif,system-ui,sans-serif;--mono:"Geist Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
  --ease:cubic-bezier(.16,1,.3,1);
}
@media (prefers-color-scheme:dark){:root{
  --bg:#0d0f11;--surface:#15181b;--sunken:#1b1f23;--line:#262b31;--fg:#eef0f2;--fg-2:#b3bac3;--fg-3:#7d8590;
  --accent:#3ccf91;--accent-ink:#06130d;--accent-soft:#12291f;
  --warn:#e3a54a;--warn-soft:#2a2012;--bad:#f0708e;--bad-soft:#2c1419;--idle:#59616b;--busy:#b3bac3;
  --hill:#22272d;--rock:#6b737d;--figure:#d4d9df;
  --shadow:0 1px 2px rgb(0 0 0 / .3),0 12px 32px -14px rgb(0 0 0 / .6);
}}
*{box-sizing:border-box}
html{scroll-behavior:smooth;-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 var(--font);-webkit-font-smoothing:antialiased;overflow-x:hidden}
a{color:inherit}
.wrap{max-width:1180px;margin:0 auto;padding:0 24px}
.mono{font-family:var(--mono);font-variant-numeric:tabular-nums}
.skip{position:absolute;left:-999px;top:8px;background:var(--fg);color:var(--bg);padding:8px 12px;border-radius:8px;z-index:20}
.skip:focus{left:8px}
:focus-visible{outline:2px solid var(--accent);outline-offset:3px;border-radius:4px}

/* Nav */
header{position:sticky;top:0;z-index:10;height:64px;display:flex;align-items:center;border-bottom:1px solid var(--line);
  background:color-mix(in srgb,var(--bg) 82%,transparent);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)}
header .wrap{display:flex;align-items:center;justify-content:space-between;width:100%}
.brand{font-weight:650;letter-spacing:-.02em;font-size:17px;text-decoration:none;display:flex;align-items:center;gap:10px}
.brand i{width:22px;height:22px;border-radius:6px;background:var(--accent);display:inline-block;position:relative;transition:transform .5s var(--ease)}
.brand:hover i{transform:rotate(90deg)}
.brand i::after{content:"";position:absolute;inset:6px 5px 6px 9px;border-left:2px solid var(--accent-ink);border-top:2px solid var(--accent-ink);transform:rotate(135deg)}
nav{display:flex;gap:28px;font-size:14px;color:var(--fg-2)}
nav a{text-decoration:none;transition:color .2s;position:relative}nav a:hover{color:var(--fg)}
nav.top a::after{content:"";position:absolute;left:0;right:0;bottom:-4px;height:1px;background:currentColor;transform:scaleX(0);transform-origin:left;transition:transform .35s var(--ease)}
nav.top a:hover::after{transform:scaleX(1)}

/* Hero: the hill fills the whole band; the copy sits over open sky on the left, behind a scrim. */
.hero{position:relative;display:grid;grid-template-columns:minmax(24px,1fr) minmax(0,1132px) minmax(24px,1fr);
  min-height:clamp(600px,calc(100dvh - 64px),860px);align-items:center;overflow:hidden;background:var(--sunken)}
.copy{grid-column:2;max-width:440px;padding:48px 0;position:relative;z-index:1}
h1{font-size:clamp(40px,4.8vw,62px);line-height:1.02;letter-spacing:-.04em;font-weight:650;margin:0 0 20px}
h1 span{display:block}h1 .quiet{color:var(--fg-3)}
.lede{font-size:17px;color:var(--fg-2);max-width:38ch;margin:0 0 32px;text-wrap:pretty}
.ctas{display:flex;align-items:center;gap:24px;flex-wrap:wrap}
.btn{font:600 15px var(--font);background:var(--accent);color:var(--accent-ink);border:0;border-radius:8px;padding:12px 20px;cursor:pointer;white-space:nowrap;position:relative;overflow:hidden;
  transition:transform .2s var(--ease),filter .2s,opacity .2s,box-shadow .3s;display:inline-flex;align-items:center;gap:10px;
  box-shadow:0 6px 20px -8px color-mix(in srgb,var(--accent) 70%,transparent)}
.btn:hover{filter:brightness(1.07);transform:translateY(-1px)}.btn:active{transform:translateY(1px) scale(.98)}
.btn:disabled{opacity:.55;cursor:not-allowed;filter:none;transform:none;box-shadow:none}
.btn::after{content:"";position:absolute;inset:0;background:linear-gradient(100deg,transparent 30%,rgb(255 255 255 / .28),transparent 70%);transform:translateX(-120%)}
.btn:not(:disabled):hover::after{transform:translateX(120%);transition:transform .8s var(--ease)}
.link{font-size:15px;font-weight:500;color:var(--fg-2);text-decoration:none;border-bottom:1px solid var(--line);padding-bottom:2px;transition:color .2s,border-color .2s}
.link:hover{color:var(--fg);border-color:var(--fg-3)}
.note{min-height:22px;margin:18px 0 0;font-size:14px;color:var(--fg-3);max-width:42ch}
.note:empty{display:none}
.note.ok{color:var(--accent)}.note.err{color:var(--bad)}
.batch{margin-top:14px;max-width:380px}
.track{height:4px;border-radius:4px;overflow:hidden;background:color-mix(in srgb,var(--line) 70%,transparent)}
.track span{display:block;height:100%;width:0;background:var(--accent);transition:width .6s var(--ease)}
.batch p{margin:8px 0 0;font-size:13.5px;color:var(--fg-2)}

/* The hill */
.scene{position:absolute;inset:0;z-index:0}
.scene canvas{opacity:0;transition:opacity 1.2s var(--ease);position:absolute;inset:0;width:100%;height:100%;display:block;cursor:grab;touch-action:pan-y}
.scene.ready canvas{opacity:1}
.scrim{position:absolute;inset:0;pointer-events:none;
  background:linear-gradient(90deg,var(--bg) 0%,color-mix(in srgb,var(--bg) 78%,transparent) 26%,transparent 52%),linear-gradient(0deg,var(--bg),transparent 16%)}
.tag{position:absolute;left:0;top:0;font:500 11.5px/1 var(--mono);color:var(--fg-2);background:color-mix(in srgb,var(--surface) 88%,transparent);
  border:1px solid var(--line);padding:5px 7px;border-radius:6px;white-space:nowrap;pointer-events:none;will-change:transform;
  box-shadow:0 2px 8px rgba(10,20,10,.25);backdrop-filter:blur(6px);transition:opacity .3s}
.tag small{display:block;margin-top:3px;font:10px/1 var(--mono);color:var(--fg-3)}
.leads{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible;filter:drop-shadow(0 1px 1px rgba(0,0,0,.45))}
.leads line{stroke:#fff;stroke-opacity:.9;stroke-width:1.25}.leads line.dash{stroke-dasharray:3 4}
.leads circle,.leads ellipse{fill:#fff;stroke:rgba(0,0,0,.35);stroke-width:1}
.hud{position:absolute;right:24px;bottom:24px;display:flex;align-items:center;gap:16px;flex-wrap:wrap;font:12px var(--mono);color:var(--fg-3);
  background:color-mix(in srgb,var(--surface) 88%,transparent);border:1px solid var(--line);border-radius:8px;padding:8px 12px;backdrop-filter:blur(6px)}
.hud b{color:var(--fg);font-weight:500}
.live{display:inline-flex;align-items:center;gap:8px;color:var(--fg-2);font:500 12px var(--font)}
.live i{width:7px;height:7px;border-radius:50%;background:var(--accent)}
.live.down i{background:var(--bad)}
.hint{position:absolute;right:24px;bottom:72px;margin:0;font-size:13px;color:var(--fg-2);transition:opacity .4s;pointer-events:none;max-width:280px;
  background:color-mix(in srgb,var(--surface) 88%,transparent);border:1px solid var(--line);border-radius:8px;padding:8px 12px;backdrop-filter:blur(6px)}
.hint.off{opacity:0}
.snd{position:absolute;right:24px;top:24px;display:inline-flex;align-items:center;gap:8px;font:500 12px var(--font);color:var(--fg-2);cursor:pointer;
  background:color-mix(in srgb,var(--surface) 88%,transparent);border:1px solid var(--line);border-radius:8px;padding:7px 11px;backdrop-filter:blur(6px);transition:color .2s,transform .1s}
.snd:hover{color:var(--fg)}.snd:active{transform:translateY(1px)}.snd:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.eq{display:inline-flex;align-items:flex-end;gap:2px;height:10px}.eq i{width:2px;height:5px;border-radius:1px;background:var(--fg-3)}.eq i:nth-child(2){height:9px}.eq i:nth-child(3){height:6px}
.snd[aria-pressed=true]{color:var(--fg)}.snd[aria-pressed=true] .eq i{background:var(--accent);animation:eq .9s ease-in-out infinite alternate}
.snd[aria-pressed=true] .eq i:nth-child(2){animation-delay:-.3s}.snd[aria-pressed=true] .eq i:nth-child(3){animation-delay:-.6s}
@keyframes eq{from{height:3px}to{height:10px}}
.nogl{position:absolute;inset:0;display:grid;place-items:center;padding:32px;text-align:center;color:var(--fg-2);font-size:14.5px}

/* Panels */
.panel{background:var(--surface);border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow);overflow:hidden}
.ph{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 20px;border-bottom:1px solid var(--line);font-size:13px;color:var(--fg-3)}
.split{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr)}
.split>div{padding:22px}.split>div+div{border-left:1px solid var(--line)}
.bar{display:flex;height:10px;border-radius:6px;overflow:hidden;margin-bottom:22px;background:var(--sunken)}
.bar span{flex:0 1 0;min-width:0;border-right:2px solid var(--surface);transition:flex-grow .8s var(--ease)}
.bar span:last-child{border-right:0}
.counts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px 12px;margin-bottom:22px}
.count .n{font:500 26px/1.1 var(--mono);letter-spacing:-.02em;display:block;font-variant-numeric:tabular-nums}
.count .l{font-size:12.5px;color:var(--fg-3);display:flex;align-items:center;gap:7px;margin-top:4px}
.count .l i{width:8px;height:8px;border-radius:2px;display:inline-block}
.spark{display:grid;grid-template-columns:auto 1fr;gap:16px;align-items:end;padding:14px 16px;background:var(--sunken);border-radius:10px}
.spark .rate{font:500 22px/1 var(--mono);min-width:64px}.spark .rate small{display:block;font:400 12px var(--font);color:var(--fg-3);margin-top:6px}
.spark svg{width:100%;height:44px;display:block}
.feed{list-style:none;margin:0;padding:0;display:grid;gap:2px}
.feed li{display:grid;grid-template-columns:80px 88px 1fr auto;align-items:center;gap:12px;padding:8px 10px;border-radius:8px;font-size:13px}
.feed li:nth-child(odd){background:var(--sunken)}
.feed li.enter{animation:enter .55s var(--ease)}
@keyframes enter{from{opacity:0;transform:translateX(-8px);background:var(--accent-soft)}to{opacity:1;transform:none}}
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
.sub{color:var(--fg-2);max-width:60ch;margin:0 0 44px;text-wrap:pretty}
.flow{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:32px;position:relative}
.flow div{border-top:2px solid var(--line);padding-top:20px;position:relative}
.flow div::before{content:"";position:absolute;top:-2px;left:0;width:40px;height:2px;background:var(--accent)}
.flow h3{font-size:17px;font-weight:600;letter-spacing:-.01em;margin:0 0 8px}
.flow p{margin:0;color:var(--fg-2);font-size:14.5px}
.flow p+p{margin-top:10px;color:var(--fg-3);font-size:13.5px}
.flow code{font:13px var(--mono);color:var(--fg)}

.bento{display:grid;grid-template-columns:1.35fr 1fr 1fr;grid-template-rows:auto auto;gap:16px}
.tile{border-radius:14px;padding:28px;background:var(--surface);border:1px solid var(--line);display:flex;flex-direction:column;justify-content:space-between;gap:28px;min-height:180px;
  transition:transform .4s var(--ease),box-shadow .4s var(--ease)}
.tile:hover{transform:translateY(-3px);box-shadow:var(--shadow)}
.tile .big{font:500 clamp(34px,4vw,52px)/1 var(--mono);letter-spacing:-.04em;font-variant-numeric:tabular-nums}
.tile p{margin:0;color:var(--fg-2);font-size:14.5px;max-width:36ch}
.tile.hero-t{grid-row:span 2;background:var(--accent-soft);border-color:transparent}
.tile.hero-t .big{font-size:clamp(48px,6vw,84px);color:var(--accent)}
.tile.wide{grid-column:span 2;background:var(--sunken);border-color:transparent;flex-direction:row;align-items:flex-end}
.fine{margin:20px 0 0;font-size:13px;color:var(--fg-3)}

.types{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:48px}
.types h3{font-size:14px;font-weight:600;color:var(--fg-3);margin:0 0 16px}
.types dl{margin:0;display:grid;gap:4px}
.types dl>div{padding:12px 14px;margin:0 -14px;border-radius:10px;transition:background .25s}
.types dl>div:hover{background:var(--sunken)}
.types dt{font:500 15px var(--mono);margin-bottom:4px}
.types dd{margin:0;color:var(--fg-2);font-size:14.5px;max-width:52ch}

footer{border-top:1px solid var(--line);padding:32px 0 48px;font-size:14px;color:var(--fg-3)}
footer .wrap{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap}
footer a{color:var(--fg-2);text-decoration:none}footer a:hover{color:var(--fg)}
footer nav{gap:24px}

/* Motion. Everything below is skipped when the visitor asks for reduced motion. */
@media (prefers-reduced-motion:no-preference){
  .rise{animation:rise .9s var(--ease) both}
  .rise.d1{animation-delay:.08s}.rise.d2{animation-delay:.16s}
  @keyframes rise{from{opacity:0;transform:translateY(14px);filter:blur(4px)}to{opacity:1;transform:none;filter:none}}
  .live i{animation:ping 2s ease-out infinite}
  @keyframes ping{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--accent) 55%,transparent)}70%,100%{box-shadow:0 0 0 7px transparent}}
  .live.down i{animation:none}
  .js-reveal .reveal{opacity:0;transform:translateY(18px);transition:opacity .8s var(--ease),transform .8s var(--ease);transition-delay:calc(var(--i,0) * 90ms)}
  .js-reveal .reveal.in{opacity:1;transform:none}
  /* A job travelling the pipeline: the dot crosses, each step lights as it passes. */
  .flow::after{content:"";position:absolute;top:-5px;left:0;width:8px;height:8px;border-radius:50%;background:var(--accent);
    box-shadow:0 0 0 4px color-mix(in srgb,var(--accent) 25%,transparent);animation:travel 6s linear infinite}
  @keyframes travel{0%{left:0;opacity:0}4%{opacity:1}92%{opacity:1}100%{left:calc(100% - 8px);opacity:0}}
  .flow div::before{animation:lit 6s var(--ease) infinite}
  .flow div:nth-child(2)::before{animation-delay:1.5s}.flow div:nth-child(3)::before{animation-delay:3s}.flow div:nth-child(4)::before{animation-delay:4.5s}
  @keyframes lit{0%{width:40px}10%,24%{width:100%}40%,100%{width:40px}}
}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}html{scroll-behavior:auto}}

@media (max-width:900px){
  .hero{grid-template-columns:16px minmax(0,1fr) 16px;min-height:0;background:var(--bg)}
  .copy{grid-column:2;padding:40px 0 20px;max-width:none}
  .scene{position:relative;grid-column:1 / -1;height:460px}
  .scrim{background:linear-gradient(180deg,var(--bg),transparent 14%,transparent 86%,var(--bg))}
  .hud{right:auto;left:16px}.hint{bottom:70px}
  .flow{grid-template-columns:repeat(2,minmax(0,1fr))}.flow::after{display:none}
  .bento{grid-template-columns:1fr 1fr}.tile.hero-t{grid-row:auto;grid-column:span 2}.tile.wide{grid-column:span 2}
  .split{grid-template-columns:1fr}.split>div+div{border-left:0;border-top:1px solid var(--line)}
}
@media (max-width:640px){
  .wrap{padding:0 16px}nav.top{display:none}
  section{padding:64px 0}
  .scene{height:400px}.hint{display:none}.snd{top:12px;right:16px}.hud{left:16px;right:16px;gap:12px}
  .tag{font-size:10px;padding:4px 5px}.tag small{font-size:9px}
  .flow,.types{grid-template-columns:1fr;gap:28px}
  .bento{grid-template-columns:1fr}.tile.hero-t,.tile.wide{grid-column:auto}.tile.wide{flex-direction:column;align-items:flex-start}
  .counts{grid-template-columns:repeat(2,minmax(0,1fr))}
  .split>div{padding:18px 16px}
  .feed li{grid-template-columns:72px 1fr auto;gap:8px}.feed .a{display:none}
}
</style></head><body>
<a class="skip" href="#main">Skip to content</a>
<header><div class="wrap">
  <a class="brand" href="/demo" aria-label="RelayQ home"><i aria-hidden="true"></i>RelayQ</a>
  <nav class="top" aria-label="Sections"><a href="#numbers-live">Live numbers</a><a href="#how">How it works</a><a href="#numbers">Benchmarks</a><a href="#types">Job types</a><a href="https://github.com/puravbhatt0504/relayq">Source</a></nav>
</div></header>

<main id="main">
<div class="hero">
  <div class="copy">
    <h1 class="rise"><span>Sisyphus,</span><span class="quiet">with retries.</span></h1>
    <p class="lede rise d1">RelayQ is my job queue. Each boulder is a real job, and when one slips, a worker pushes it again.</p>
    <div class="ctas rise d2">
      <button class="btn" id="run" type="button">Run 100 jobs</button>
      <a class="link" href="https://github.com/puravbhatt0504/relayq">Read the source</a>
    </div>
    <p class="note" id="msg" role="status" aria-live="polite"></p>
    <div class="batch" id="batch" hidden><div class="track"><span id="bfill"></span></div><p id="btext"></p></div>
  </div>

  <div class="scene" id="scene">
    <canvas id="gl" role="img" aria-label="A 3D hill driven by live data. Each job is a boulder: it drops in through the API, lands on the Postgres slab, waits in line at the foot of the hill, and a worker pushes it up to the webhook flag at the top. Failed attempts roll back down and wait to be pushed again."></canvas><div class="scrim"></div>
    <button class="snd" id="snd" type="button" aria-pressed="false" hidden><span class="eq" aria-hidden="true"><i></i><i></i><i></i></span><span>Sound off</span></button>
    <div class="hud" aria-hidden="true">
      <span class="live" id="live"><i></i><span id="liveText">Connecting</span></span>
      <span>in line <b id="hq">0</b></span><span>climbing <b id="hw">0</b></span><span>at the top <b id="hd">0</b></span><span>rolled back <b id="hs">0</b></span>
    </div>
    <p class="hint" id="hint">Loading the hill</p>
  </div>
</div>

<section id="numbers-live"><div class="wrap">
  <h2 class="reveal">The same hill, in plain numbers</h2>
  <p class="sub reveal" style="--i:1">Straight from the database, refreshed every second. These are running totals for the demo tenant, so they include everyone else who pressed the button.</p>
  <div class="panel reveal" style="--i:2">
    <div class="ph"><span>Updated every second</span><span class="mono">tenant: demo</span></div>
    <div class="split">
      <div>
        <div class="bar" id="bar" aria-hidden="true"></div>
        <div class="counts" id="counts"></div>
        <div class="spark">
          <div class="rate"><span id="rate">0</span><small>deliveries / s</small></div>
          <svg viewBox="0 0 300 44" preserveAspectRatio="none" aria-label="Deliveries per second, last 60 seconds" role="img">
            <path id="area" fill="var(--accent-soft)" d=""/><path id="line" fill="none" stroke="var(--accent)" stroke-width="1.6" vector-effect="non-scaling-stroke" d=""/>
          </svg>
        </div>
      </div>
      <div><ul class="feed" id="feed" aria-label="Most recently updated jobs"></ul></div>
    </div>
  </div>
</div></section>

<section id="how"><div class="wrap">
  <h2 class="reveal">What the button actually does</h2>
  <p class="sub reveal" style="--i:1">It takes the same path any API client would. The only fake part is the receiving end, which fails on purpose so you can watch a retry.</p>
  <div class="flow">
    <div class="reveal" style="--i:2"><h3>Commit</h3><p><code>POST /jobs</code> writes your job and an outbox row in one Postgres transaction. If you got a 202 back, it is on disk.</p><p>On the hill: the stone slab every boulder lands on first.</p></div>
    <div class="reveal" style="--i:3"><h3>Relay</h3><p>A relay picks up committed rows with <code>SKIP LOCKED</code> and pushes them to Redis. Run three relays at once and still nothing goes out twice.</p><p>On the hill: the line at the foot.</p></div>
    <div class="reveal" style="--i:4"><h3>Deliver</h3><p>A worker sends a signed webhook. The idempotency key stays the same on every retry, so the receiver can spot a duplicate.</p><p>On the hill: the climb to the flag.</p></div>
    <div class="reveal" style="--i:5"><h3>Retry</h3><p>Each failure waits a bit longer than the last. After five strikes the job parks in a dead-letter queue until a human looks at it.</p><p>On the hill: the boulder rolling back down.</p></div>
  </div>
</div></section>

<section id="numbers"><div class="wrap">
  <h2 class="reveal">Numbers from my laptop, not from a slide</h2>
  <p class="sub reveal" style="--i:1">I ran all of these myself. The load test and the chaos test are in the repo, so you can run them too.</p>
  <div class="bento">
    <div class="tile hero-t reveal" style="--i:2"><span class="big" data-to="33424">33,424</span><p>jobs a minute over a five minute k6 run. The workers never fell behind.</p></div>
    <div class="tile reveal" style="--i:3"><span class="big"><span data-to="0">0</span> lost</span><p>167,133 jobs in, 167,133 jobs out.</p></div>
    <div class="tile reveal" style="--i:4"><span class="big"><span data-to="130.6" data-dec="1">130.6</span> ms</span><p>p95 to accept a job while all of that was going on.</p></div>
    <div class="tile wide reveal" style="--i:5"><span class="big" data-to="10000">10,000</span><p>jobs while a script SIGKILLed a worker every 3 seconds, and the API once for good measure. The receiver counted exactly 10,000 distinct jobs. Not 9,999, not 10,003.</p></div>
  </div>
  <p class="fine reveal">One laptop, Docker Compose, 3 workers running 5 jobs each, Postgres 16, Redis 7. A real server should do better.</p>
</div></section>

<section id="types"><div class="wrap">
  <h2 class="reveal">Six kinds of work, one queue system</h2>
  <p class="sub reveal" style="--i:1">Each kind gets its own queue and limits, so a pile of exports can't starve your webhooks. The AI ones also get spending caps, because a runaway LLM bill is how side projects die.</p>
  <div class="types">
    <div class="reveal" style="--i:2"><h3>Delivery</h3><dl>
      <div><dt>webhook.deliver</dt><dd>Signed POST to your URL. Requests aimed at localhost or cloud metadata addresses get refused, so nobody can use it to poke around inside the network.</dd></div>
      <div><dt>email.digest</dt><dd>Renders a digest and sends it through SES, never faster than SES allows.</dd></div>
      <div><dt>board.export</dt><dd>Builds a CSV or JSON export and calls you back with a link to it.</dd></div>
    </dl></div>
    <div class="reveal" style="--i:3"><h3>AI workloads</h3><dl>
      <div><dt>embed.batch</dt><dd>Bundles small embedding jobs together. 300 jobs turn into at most 4 calls to the provider.</dd></div>
      <div><dt>llm.complete</dt><dd>Sets aside the expected cost from a monthly budget before calling the model. If the model is overloaded, it falls back to a second one.</dd></div>
      <div><dt>ml.retrain</dt><dd>Trains a new model and only ships it if it beats the current one. If it doesn't, it gets politely turned away.</dd></div>
    </dl></div>
  </div>
</div></section>
</main>

<footer><div class="wrap">
  <span>Built by Purav Bhatt, mostly so I could try to break it.</span>
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
  var seen={},hist=[],prev=null,first=true;

  function esc(s){return String(s).replace(/[&<>"]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]})}
  function fmt(n,dec){return n.toLocaleString("en-US",{minimumFractionDigits:dec||0,maximumFractionDigits:dec||0})}
  function ago(t){var s=Math.max(0,Math.round((Date.now()-new Date(t))/1000));return s<60?s+"s ago":Math.round(s/60)+"m ago"}
  function sum(o){var t=0;for(var k in o)t+=o[k];return t}

  // Animates a number in place; a newer call on the same element cancels the older one.
  function tween(el,to,dur,dec){
    var from=+el.getAttribute("data-v")||0,id=(el._tw||0)+1;el._tw=id;el.setAttribute("data-v",to);
    if(reduce||from===to){el.textContent=fmt(to,dec);return}
    var t0=performance.now();
    (function f(now){if(el._tw!==id)return;var k=Math.min(1,(now-t0)/dur);k=1-Math.pow(1-k,4);
      el.textContent=fmt(from+(to-from)*k,dec);if(k<1)requestAnimationFrame(f)})(t0);
  }

  // Scroll reveal and count-up for the benchmark tiles.
  if(!reduce&&"IntersectionObserver" in window){
    document.documentElement.classList.add("js-reveal");
    var io=new IntersectionObserver(function(es){es.forEach(function(e){
      if(!e.isIntersecting)return;e.target.classList.add("in");io.unobserve(e.target);
      e.target.querySelectorAll("[data-to]").forEach(function(n){var to=+n.getAttribute("data-to"),dec=+n.getAttribute("data-dec")||0;n.setAttribute("data-v",0);n.textContent=fmt(0,dec);setTimeout(function(){tween(n,to,1600,dec)},250)});
    })},{rootMargin:"0px 0px -8% 0px"});
    document.querySelectorAll(".reveal").forEach(function(el){io.observe(el)});
  }

  // Count cells and bar segments are built once, then updated in place so they can animate.
  var cells=KINDS.slice(0,5).map(function(k){return{key:k[0],label:k[1],color:k[2]}});
  cells.push({key:"http",label:"HTTP deliveries",color:""});
  $("counts").innerHTML=cells.map(function(c){return '<div class="count"><span class="n mono" id="n-'+c.key+'">0</span><span class="l">'+(c.color?'<i style="background:'+c.color+'"></i>':'')+c.label+'</span></div>'}).join("");
  $("bar").innerHTML=KINDS.map(function(k){return '<span id="b-'+k[0]+'" title="'+k[1]+'" style="background:'+k[2]+'"></span>'}).join("");
  $("feed").innerHTML=[0,1,2,3,4,5].map(function(){return '<li><span class="sk">id</span><span class="sk">status</span><span></span><span></span></li>'}).join("");

  function counts(s){
    cells.forEach(function(c){tween($("n-"+c.key),c.key==="http"?s.sink.deliveries:(s.jobs[c.key]||0),700)});
    KINDS.forEach(function(k){var n=s.jobs[k[0]]||0,el=$("b-"+k[0]);el.style.flexGrow=n;el.style.borderRightWidth=n?"":"0"});
  }

  function spark(s){
    var now=Date.now();
    if(prev){var dt=(now-prev.t)/1000;hist.push(Math.max(0,(s.sink.deliveries-prev.d)/dt))}
    prev={t:now,d:s.sink.deliveries};
    if(hist.length>60)hist.shift();
    // Average the last three seconds so the readout doesn't flicker between 0 and a spike.
    var tail=hist.slice(-3),r=tail.length?tail.reduce(function(a,b){return a+b},0)/tail.length:0;
    $("rate").textContent=r<10?r.toFixed(1):Math.round(r);
    var max=Math.max(5,Math.max.apply(null,hist.concat([0]))),n=60,pts=[];
    for(var i=0;i<hist.length;i++){pts.push([(300*(n-hist.length+i))/(n-1),42-(hist[i]/max)*38])}
    if(pts.length<2){$("line").setAttribute("d","");$("area").setAttribute("d","");return}
    var d="M"+pts.map(function(p){return p[0].toFixed(1)+" "+p[1].toFixed(1)}).join(" L");
    $("line").setAttribute("d",d);
    $("area").setAttribute("d",d+" L"+pts[pts.length-1][0].toFixed(1)+" 44 L"+pts[0][0].toFixed(1)+" 44 Z");
  }

  function feed(s){
    if(!s.recent.length){$("feed").innerHTML='<li class="empty" style="display:block">Nothing here yet. Run a batch and the latest jobs will show up as they move.</li>';return}
    $("feed").innerHTML=s.recent.map(function(j){
      var fresh=!first&&!seen[j.id+j.status]?" enter":"";seen[j.id+j.status]=1;
      var a=j.attempts>1?'<span class="a retried">took '+j.attempts+' tries</span>':'<span class="a">'+j.attempts+' attempt'+(j.attempts===1?"":"s")+'</span>';
      return '<li class="'+fresh+'"><span class="id mono">'+esc(j.id.slice(0,8))+'</span><span class="chip s-'+esc(j.status)+'">'+esc(LABEL[j.status]||j.status)+'</span>'+a+'<span class="t mono">'+ago(j.updatedAt)+'</span></li>';
    }).join("");
  }

  // Progress for the batch this visitor started. Totals are tenant-wide, so this is a close read, not an exact one.
  var batch=null;
  function progress(s){
    if(!batch||batch.over)return;
    var done=Math.min(100,Math.max(0,(s.jobs.completed||0)-batch.c0)),waiting=s.jobs.failed||0;
    $("bfill").style.width=done+"%";
    if(done<100){$("btext").textContent=done+" of 100 at the top"+(waiting?", "+waiting+" rolled back and waiting":"");return}
    var calls=Math.max(100,s.sink.deliveries-batch.d0),secs=((Date.now()-batch.t0)/1000).toFixed(1),extra=calls-100;
    $("btext").textContent="All 100 made it in "+secs+"s. "+(extra>0?extra+" slipped on the way and got pushed again.":"Not one slipped.");
    batch.over=true;
  }

  function tick(){
    fetch("/demo/stats").then(function(r){if(!r.ok)throw r;return r.json()}).then(function(s){
      $("live").className="live";$("liveText").textContent="Live";
      counts(s);spark(s);feed(s);progress(s);if(window.relayqHill)window.relayqHill.ingest(s);first=false;
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
    var c0=+$("n-completed").getAttribute("data-v")||0,d0=+$("n-http").getAttribute("data-v")||0;
    fetch("/demo/run",{method:"POST"}).then(function(r){return r.json().then(function(b){return{ok:r.ok,b:b}})}).then(function(x){
      if(x.ok){
        msg.className="note ok";msg.textContent="100 boulders on their way. Watch for the amber ones.";cooldown(10);
        batch={c0:c0,d0:d0,t0:Date.now()};$("batch").hidden=false;$("bfill").style.width="0%";$("btext").textContent="0 of 100 at the top";
      }
      else{msg.className="note err";msg.textContent="Someone else just started a run. "+(x.b.error||"Try again in a few seconds.");cooldown(5)}
    }).catch(function(){msg.className="note err";msg.textContent="Couldn't reach the API. Check your connection and try again.";btn.disabled=false});
  });

  tick();setInterval(tick,1000);

})();
</script>
<script type="importmap">{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.165.0/build/three.module.js","three/addons/":"https://cdn.jsdelivr.net/npm/three@0.165.0/examples/jsm/"}}</script>
<script type="module" src="/demo/assets/hill.js?v=7"></script>
</body></html>`;
