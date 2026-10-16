# RelayQ — PLAN

A standalone background-job service: other apps POST jobs over HTTP, BullMQ
workers run them with retries, backoff, rate limits and idempotency, and a
dashboard shows what's happening. First client: **PulseBoard** (`../pulseboard`).
**This file is the contract.** Each phase ends in a check that can fail.

Resume line this must earn:
> RelayQ — distributed job queue service (Node.js, TypeScript, BullMQ, Redis,
> PostgreSQL, Docker, AWS). Idempotent HTTP enqueue, exponential-backoff retries,
> dead-letter queue, per-tenant rate limits, Prometheus metrics; processes
> 33,000+ jobs/min across 3 workers (measured: 33,424/min, 0 lost, p95 enqueue 131 ms).

---

## Stack (fixed)

| Layer | Choice |
|---|---|
| API | Node.js 20, TypeScript, Fastify 4, `zod` validation |
| Queue | BullMQ 5 on Redis 7 |
| DB | PostgreSQL 16 (job history, API keys), Prisma |
| Email | AWS SES (Nodemailer SES transport); local: MailHog |
| Files | AWS S3 (export output) |
| Metrics | `prom-client` → `/metrics`; Grafana in compose |
| Dashboard | `@bull-board/fastify` + own `/stats` page |
| Tests | Vitest, Testcontainers (real Redis/Postgres) |
| Infra | Docker Compose, AWS ECS Fargate (api + worker services), GitHub Actions |

## Layout

```
relayq/
  src/api/server.ts        Fastify app
  src/api/routes/jobs.ts   POST /jobs, GET /jobs/:id
  src/api/auth.ts          API-key auth (sha256-hashed keys in Postgres)
  src/queue/queues.ts      queue definitions + default job options
  src/worker/index.ts      worker boot (separate process)
  src/worker/handlers/     email.digest.ts, board.export.ts, webhook.deliver.ts
  src/lib/idempotency.ts
  src/lib/metrics.ts
  prisma/schema.prisma
  docker-compose.yml
  .github/workflows/ci.yml
  load/enqueue.k6.js
```

---

## Phase 1 — Enqueue API

- Auth: `Authorization: Bearer rq_<key>`; stored as sha256; missing/unknown → `401`. Each key belongs to a `tenant`.
- `POST /jobs {type, payload, idempotencyKey?, delayMs?}`
  - `type` must be one of `email.digest | board.export | webhook.deliver` → else `400`
  - `payload` validated by that type's zod schema → else `400 {errors}`
  - → `202 {jobId, status:"queued"}`
  - Same `idempotencyKey` + tenant within 24 h → `200` with the **original** `jobId`, no second job (`src/lib/idempotency.ts`, Redis `SET NX EX 86400`)
- `GET /jobs/:id` → `{id, type, status: queued|active|completed|failed|dead, attempts, result?, error?}`; other tenant's job → `404`
- Every job also written to Postgres `JobRecord` (history survives Redis flush).

**Done:** `jobs.test.ts` (Testcontainers): 202 on valid; 400 on unknown type and bad payload; 401 no key; duplicate idempotency key returns same jobId and queue count stays 1; cross-tenant GET → 404.

## Phase 2 — Workers, retries, dead letters

- Worker is a separate process (`npm run worker`), concurrency from `WORKER_CONCURRENCY` (default 5).
- Default options: `attempts: 5`, `backoff: {type:"exponential", delay: 2000}` → delays 2s, 4s, 8s, 16s.
- After the last failure: job moved to `dead` queue, `JobRecord.status = "dead"`, error stored.
- `POST /jobs/:id/retry` re-queues a dead job (attempts reset).
- Handlers:
  - `email.digest {to, userName, items[]}` → renders HTML, sends via SES. Returns `{messageId}`.
  - `board.export {boardId, format:"csv"|"json", callbackUrl}` → fetches board from PulseBoard, writes to S3, POSTs `{jobId, url}` to `callbackUrl`.
  - `webhook.deliver {url, body}` → POST with HMAC-SHA256 signature header `X-RelayQ-Signature`; non-2xx = failure (retried).
- Graceful shutdown: on SIGTERM, stop taking jobs, finish active ones (30 s max), then exit.

**Done:** `worker.test.ts`: a handler that always throws ends `dead` after exactly 5 attempts; a handler failing twice then succeeding ends `completed` with `attempts = 3`; SIGTERM during an active job lets it complete; webhook signature verifies with the shared secret.

## Phase 3 — Rate limits and priorities

- Per-tenant limit: default 100 jobs/min per tenant (`TENANT_JOBS_PER_MIN`); excess stays queued (not rejected). BullMQ groups are Pro-only, so: Redis fixed-window counter checked in the worker, over-limit jobs `moveToDelayed` + `DelayedError` (no attempt used).
- Per-type limit: `email.digest` ≤ 14/s (SES sandbox ceiling).
- `priority` field (1 high … 10 low) on POST; default 5.
- Enqueue-side cap: > 10,000 queued jobs for one tenant → `429`.

**Done:** test enqueues 300 jobs for one tenant with limit 100/min and asserts ≤ 100 complete in the first 60 s (use fake limiter window of 1 s / 10 jobs to keep the test fast); priority-1 job enqueued after 50 priority-5 jobs completes before them.

## Phase 4 — Observability + dashboard

- `/metrics` (Prometheus): `relayq_jobs_total{type,status}`, `relayq_job_duration_seconds` histogram, `relayq_queue_depth{queue}`.
- `/admin/queues` → bull-board (behind basic auth).
- Structured JSON logs (`pino`) with `jobId` on every line.
- Grafana dashboard JSON committed at `ops/grafana-dashboard.json`.

**Done:** after processing 10 jobs, `GET /metrics` contains `relayq_jobs_total{type="webhook.deliver",status="completed"} 10`; `/admin/queues` without auth → `401`.

## Phase 5 — Docker, CI, AWS

- `docker-compose.yml`: `api`, `worker` (×3 via `deploy.replicas`), `redis`, `postgres`, `mailhog`, `prometheus`, `grafana`.
- CI: lint, typecheck, tests (Testcontainers), build images.
- AWS (`infra/`, CDK, ap-south-1): two ECS Fargate services (api, worker 1–3 autoscaled on a `RelayQ/QueueDepth` CloudWatch metric the api emits as EMF), ElastiCache, RDS, SES, S3, ALB behind CloudFront for HTTPS. No NAT. Secrets in Secrets Manager (CloudFormation can't create SSM SecureStrings).
- **Budget constraint (AWS Free plan, credits only):** AWS runs for a fixed window, not permanently. `RelayQReaper` stack: one-time EventBridge Scheduler `DeleteStack` at `DESTROY_AT` (default +5 days) + $25 cost-budget email alert. Always-on public demo instead runs free on Render (web service sleeps when idle, wakes on request) + Neon Postgres + Render Key Value: `render.yaml`, `src/all.ts`, public `/demo` page.

**Done:** CI green on `main`; `curl <prod>/health` → `200 {"redis":"ok","db":"ok"}` on the AWS URL while the window is open (HTTP on the ALB: CloudFront needs AWS account verification, requested); demo run on AWS completes 100/100 jobs; Render demo URL wakes from sleep and completes a demo run. ~~PulseBoard export end-to-end in prod~~ deferred until PulseBoard's own deploy exists (needs its service-auth board fetch + callback route).

## Phase 6 — Throughput number (the resume number)

- `load/enqueue.k6.js`: 50 VUs enqueue `webhook.deliver` jobs to a local sink for 5 minutes against 3 workers.

**Done:** record jobs/min completed and p95 enqueue latency in `README.md`; resume line uses the measured N, never a guessed one. Zero jobs lost: `count(JobRecord where status in (completed,dead)) == enqueued`.

## Phase 7 — Exactly-once effects: transactional outbox + chaos test — the "advanced" upgrade

Problem today: `POST /jobs` writes `JobRecord` to Postgres and adds to Redis as two separate steps. A crash between them loses a job or leaves a ghost record. And BullMQ is at-least-once, so a worker killed after the side effect but before ack runs it twice.

- **Outbox (enqueue side):** `POST /jobs` does one Postgres transaction: insert `JobRecord(status:"pending")` + `Outbox{id, jobId, createdAt, publishedAt:null}`. Returns 202 only after commit. Redis is not touched in the request.
- **Relay** `src/outbox/relay.ts`: loop `SELECT … FROM Outbox WHERE publishedAt IS NULL ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED`, add each to BullMQ with `jobId = JobRecord.id` (BullMQ dedupes on jobId, so re-publishing after a crash is harmless), then set `publishedAt`. Runs inside the api process; multiple instances safe via `SKIP LOCKED`.
- **Idempotent effects (worker side):** `src/lib/effects.ts` `once(jobId, step, fn)` — inserts `EffectLog(jobId, step)` with a unique constraint *in the same transaction* as any DB write `fn` does; for external calls (SES, webhook), the key is passed downstream (`Idempotency-Key: {jobId}:{step}` header on webhooks, SES `MessageDeduplicationId` via a sent-log check). Second execution of a completed step → skipped, returns stored result.
- Retention: delete published outbox rows older than 7 days (daily).

Examples:
- Process crash after commit, before relay → job is published on restart, runs once.
- Worker `SIGKILL` after sending the email, before ack → BullMQ re-delivers; `once()` sees `EffectLog(job, "send")` and skips; exactly one email in MailHog.

**Done — `chaos/` suite (`npm run chaos`; CI workflow is manual-trigger to save Actions minutes):**
- Enqueue 10,000 `webhook.deliver` jobs to a sink that records `Idempotency-Key`s, while a script `docker kill`s a random worker every 3 s (and restarts it) and kills the api once mid-run.
- Assert: every enqueued job reaches `completed`; sink received exactly 10,000 distinct keys (**0 lost, 0 duplicated effects**); outbox has 0 unpublished rows after drain.
- Unit: `relay.test.ts` — two relays on the same table never publish a row twice; `effects.test.ts` — `once()` called twice runs `fn` once.

Resume line gains: *"transactional outbox + idempotent effects; chaos-tested with random worker kills across 10k jobs: 0 lost, 0 duplicated."*

## Phase 8 — Distributed tracing

- OpenTelemetry SDK in `src/otel.ts` for api and worker; auto-instrument fastify, pg, ioredis.
- `POST /jobs` extracts incoming `traceparent` (from PulseBoard) and stores it in job data; the worker starts its span as a child of it — so one trace spans HTTP → outbox → queue → worker → callback.
- Jaeger in compose; ADOT → X-Ray in prod.

**Done:** `otel.test.ts`: a job enqueued with `traceparent: 00-<T>-…` produces a worker span whose trace-id is `<T>`. In compose, PulseBoard's export shows as a single trace (see PulseBoard Phase 9).

---

# AI infrastructure phases

RelayQ becomes where AI work runs: batch embeddings, LLM calls with budgets and fallbacks, and ML retraining. Consumers: PulseBoard Phases 10–13.

## Phase 9 — `embed.batch` job type

- Payload `{tenant, items:[{id, text}], model:"voyage-3.5", callbackUrl}`; ≤ 128 items per job, else `400`.
- Worker coalesces queued `embed.batch` jobs for the same tenant/model up to 128 items or 500 ms, makes one provider call, splits results back per job (fewer, larger requests).
- Provider 429 → job delayed by `Retry-After` (not counted as a failed attempt); 5xx → normal backoff.
- Result POSTed to `callbackUrl` as `{items:[{id, embedding:number[1024]}]}` with the HMAC signature header; exactly-once via Phase 7's `once()`.

**Done:** `embed.test.ts` with a mock provider: 300 single-item jobs enqueued together → ≤ 4 provider calls and 300 correct callbacks; a 429 with `Retry-After: 2` delays ~2 s and leaves `attempts` unchanged; 129 items → 400.

## Phase 10 — `llm.complete`: token budgets, fallback, cost tracking

- Payload `{tenant, model, system, messages, tools?, maxTokens, fallbackModel?, callbackUrl}`.
- **Budgets:** `TenantBudget{tenant, monthlyUsdLimit}`; before running, reserve estimated cost (input tokens counted via the provider's token-count API + `maxTokens`) in Redis; settle with actual usage after. Over budget → job `failed` with `error:"budget_exceeded"` (not retried) and a webhook to the tenant.
- **Rate limits:** per-provider tokens-per-minute limiter (Redis token bucket) shared by all workers.
- **Fallback:** primary returns 529/overloaded or times out (60 s) twice → retry once on `fallbackModel`; result records `modelUsed`.
- **Cost ledger:** `LlmUsage{jobId, tenant, model, inputTokens, outputTokens, costUsd, latencyMs}`; prices in `src/llm/prices.ts` (one table, unit-tested).
- Prompt caching: system prompts > 1,024 tokens sent with cache control; cache-read tokens recorded separately in the ledger.
- Metrics: `relayq_llm_tokens_total{model,kind}`, `relayq_llm_cost_usd_total{tenant,model}`, `relayq_llm_latency_seconds`. Grafana panel "LLM cost per tenant per day".

**Done:** `llm.test.ts` (mock provider): tenant with $0.01 left and a job estimated at $0.02 → `budget_exceeded`, no provider call; two overloaded responses → completes on fallback with `modelUsed = fallback`; ledger cost equals `prices.ts` × tokens to the cent; 20 concurrent jobs never exceed the TPM limit (assert from mock call timestamps).

## Phase 11 — `ml.retrain` + model registry

- Job type `ml.retrain {modelName:"eta", dataUrl}` runs the PulseBoard `ml/eta` training container as an ECS task (worker launches it with `RunTask` and polls; locally `docker run`).
- Registry table `ModelVersion{name, version, s3Uri, metrics jsonb, status: candidate|promoted|rejected, createdAt}`.
- Promotion rule: candidate's test MAE ≤ promoted MAE → promote (atomic swap of `status`) and POST `{name, version}` to subscribers so the predictor reloads; else `rejected` with reason.
- `GET /models/:name` → current promoted version + metric history.

**Done:** `retrain.test.ts` with a stub trainer: better MAE → promoted and subscriber notified once; worse MAE → `rejected`, promoted version unchanged; trainer crash → job retried per Phase 2, no half-promoted state (exactly one `promoted` row per name, asserted by a partial unique index).

## Phase 12 — SSRF guard on outbound calls

Every tenant-supplied URL (`webhook.deliver.url`, every `callbackUrl`, `MODEL_SUBSCRIBERS_*`) goes out through `signedPost` in `src/worker/handlers/webhook.deliver.ts`, so the guard lives there.

- `src/lib/ssrf.ts`:
  - `isBlockedIp(ip: string): boolean`. True for loopback, private (RFC 1918), CGNAT `100.64/10`, link-local `169.254/16` (incl. `169.254.169.254` metadata), `0/8`, multicast, reserved `240/4`, broadcast, IPv6 `::`, `::1`, `fc00::/7`, `fe80::/10`, `ff00::/8`, NAT64 `64:ff9b::/96`, and IPv4-mapped forms (`::ffff:127.0.0.1`). E.g. `isBlockedIp("10.1.2.3") → true`, `isBlockedIp("8.8.8.8") → false`.
  - `isAllowed(host, port)`: matches `OUTBOUND_ALLOW` (comma list of `host` or `host:port`), plus `127.0.0.1:$PORT` when `DEMO=1` (the demo's own sink). Allowed hosts skip the IP check.
  - `guardedLookup`: a `dns.lookup` drop-in for `http.request` that resolves all addresses and fails with `EBLOCKED` if any is blocked. The checked IP is the one connected to, so DNS rebinding can't swap it.
- `signedPost` uses `node:http` / `node:https` with `guardedLookup` instead of `fetch`.
  - Redirects are not followed: a 3xx is non-2xx and retries like any failure.
  - Literal-IP hosts are checked before connecting, since `lookup` isn't called for them.
  - A non-`http(s)` scheme or a blocked address → `Rejected("blocked_url: <reason>")`, so the job ends `failed` and is not retried.
- Config: compose sets `OUTBOUND_ALLOW` for its internal sinks; tests set it to `127.0.0.1,localhost`.

**Done:** `ssrf.test.ts`:
- `isBlockedIp` table: blocked for `127.0.0.1`, `10.0.0.1`, `172.16.5.4`, `192.168.1.1`, `169.254.169.254`, `100.64.0.1`, `0.0.0.0`, `::1`, `fd00::1`, `fe80::1`, `::ffff:127.0.0.1`, `::ffff:a9fe:a9fe`; allowed for `8.8.8.8`, `1.1.1.1`, `2606:4700:4700::1111`.
- `webhook.deliver` to `http://169.254.169.254/latest/meta-data/` → job `failed`, error starts `blocked_url`, 1 attempt.
- To `http://localhost:<sink>/` with `OUTBOUND_ALLOW` unset → blocked, and the sink got 0 requests.
- To the same sink with `OUTBOUND_ALLOW=localhost` → `completed`.
- Sink answers `302 → http://169.254.169.254/` → not followed: the job retries and the sink saw no metadata request.
- `ftp://example.com/x` → `blocked_url`.

## Phase 13 — LLM budgets and usage over HTTP

Today a budget can only be set with SQL, and tenants can't see what they've spent. New file `src/api/routes/llm.ts`:

- `GET /llm/usage?month=YYYY-MM` (tenant bearer key; month defaults to the current UTC month) → `{month, limitUsd, spentUsd, remainingUsd, byModel: [{model, calls, inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens, costUsd}]}`.
  - Spend comes from the `LlmUsage` ledger (settled cost only), only the caller's own rows.
  - `limitUsd` is the `TenantBudget` row, else `LLM_DEFAULT_MONTHLY_USD` (0). `remainingUsd = max(0, limit − spent)`.
  - `byModel` is sorted by cost, descending.
  - Bad month (`2026-13`, `abc`) → 400.
- `PUT /admin/budgets/:tenant {monthlyUsdLimit}` (admin basic auth) → upsert → `200 {tenant, monthlyUsdLimit}`. The limit must be a number with 0 ≤ x ≤ 1,000,000, else 400. It takes effect on the next reservation, because `reserveBudget` reads the row each time.
- `GET /admin/budgets` (admin) → `[{tenant, monthlyUsdLimit}]`.

**Done:** `llm-api.test.ts`:
- Seed `LlmUsage` for tenant A: 2 sonnet rows ($0.30 + $0.20) and 1 haiku row ($0.05) this month, 1 sonnet row ($9) last month; 1 row for tenant B.
- `GET /llm/usage` as A with a $1 budget → `spentUsd 0.55`, `remainingUsd 0.45`, byModel `[sonnet: 2 calls $0.50, haiku: 1 call $0.05]`.
- `?month=<last month>` → `spentUsd 9`, `remainingUsd 0`. `?month=2026-13` → 400.
- `PUT /admin/budgets/B {monthlyUsdLimit: 5}` without auth → 401; with auth → 200, and B's usage then shows `limitUsd 5`. Limit `-1` → 400.
- No budget row and the env default unset → `limitUsd 0`.

## Phase 14 — Token-protected `/metrics`

`/metrics` on the public api exposes tenant names, per-tenant LLM cost and job volumes.

- `src/api/server.ts`: if `METRICS_TOKEN` is set, `GET /metrics` requires `Authorization: Bearer <token>` (timing-safe compare), else `401`. Unset = open, as today (local compose Prometheus).
- `render.yaml` generates `METRICS_TOKEN`. `/health` stays open: Render's health check needs it, and it reveals only `{redis, db}`.

**Done:** `metrics.test.ts`:
- With `METRICS_TOKEN=t`: no header → 401; `Bearer wrong` → 401; `Bearer t` → 200 and the body contains `relayq_jobs_total`.
- Unset → 200 with no header.

## Phase 15 — Demo hill: "See inside" (the cutaway)

The hill can be cut open to show the machinery under it. The surface keeps doing what it does; underneath, each job's record travels through Postgres, the relay, Redis, backoff and the dead-letter pit as a spark. Storyboard: the "Under the hill" board on the design canvas.

**Files:** `public/demo/assets/hill.js` (new section `// ---- Under the hill`), `public/demo/assets/sound.js` (new one-shots), `src/api/demo.ts` (button, CSS, `hill.js?v=`).

**The cut.** A clipping plane keeps `z ≤ ZC`. Open: `ZC = 12.5`. Closed: `ZC = 1000`, so nothing is clipped. It clips the terrain, grass, pebbles, outcrops and slab. A cap mesh fills the cut face from `ground(x, ZC)` down to y −40, for x −120 to 140. The cap has rock texture, strata that darken with depth and a topsoil band, and holes where the rooms are, with a shaded rim. While open, waiting boulders are held at `z ≤ ZC − r`.

**Rooms** are open-front boxes behind the cut, at `x0..x1, y0..y1`, `depth` metres deep. They are lit only by their own lanterns.

| room | x | y | depth | inside |
|---|---|---|---|---|
| shaft A (slab → vault) | −9.0..−8.2 | −1.6..surface | 2 | |
| vault (Postgres) | −12.5..−6.5 | −5.6..−1.6 | 3.5 | 4×12 shelf of tablets; sign `POSTGRES` / `N rows` |
| relay tunnel | −6.5..−3.5 | −4.8..−3.6 | 2.5 | iron pipe; sign `RELAY` |
| cistern (Redis) | −3.5..2.5 | −6.2..−2.4 | 3.5 | 4×8 rack of slots; sign `REDIS` / `N waiting` |
| lift B | −0.6..0.2 | −2.4..surface | 2 | |
| backoff pocket | 3.5..8.0 | −4.4..−2.2 | 3 | amber embers; sign `BACKOFF` / `N retrying` |
| shaft C | 6.2..7.0 | −2.2..surface | 2 | |
| chute | 7.4..8.0 | −6.5..−4.4 | 2 | |
| pit (dead letters) | 6.5..11.0 | −10.5..−6.5 | 3.5 | red embers on the floor; sign `DEAD LETTERS` / `N` |
| shaft E (flag) | 14.6..15.4 | −1.6..surface | 2 | |
| conduit | 15.0..60 | −1.6..−0.6 | 2 | iron pipe; sign `WEBHOOK` / `to your server` (left of shaft E) |

**Counts.** Each room shows a number that follows a target, on a sign carved into the cut face above the room. With the cut open, a spark's arrival moves it one step, never past the target. If no spark of that kind has flown for 1.5 s, every 0.15 s it closes a quarter of the gap (at least 1). With the cut closed, it equals the target.
- vault = boulders that have landed (all time).
- cistern = waiting grey boulders + `spawnLeft`.
- backoff = waiting amber boulders.
- pit = dead letters (all time).

**Sparks.** Each spark flies a Catmull-Rom path through these rooms at z = `ZC − 0.9`. At most 24 fly at once; extras are skipped, and the counts reconcile.

| event | path | on arrival |
|---|---|---|
| slab landing | slab → shaft A → vault shelf | the tablet flashes; then relay spark → tunnel → cistern slot |
| dispatch | cistern (amber: backoff) → lift B (amber: shaft C) → boulder | |
| slip | boulder → shaft C → backoff | |
| dead | boulder → shaft C → backoff → chute → pit | |
| delivery | flag → shaft E → conduit → off screen | |

**Choreography,** in seconds from the press:
- Open:
  - camera eases 0→2.2 to the side-on pose: yaw 0, pitch 0.05, look y −3.2;
  - the cut sweeps `ZC` 26→12.5 over 0.3→1.5, with dust along its top edge;
  - the rooms carve open one after another, 0.12 s apart, from 1.5, each taking 0.5 s;
  - the lanterns light left to right over 2.4→3.0.
- Close: the rooms shut over 0→0.5, the cut sweeps back 0.4→1.2, the camera returns 0→1.4, then `ZC = 1000`.
- Reduced motion: the final state, with no animation.
- Callout pills fade out while open.

**Sound:** `grind` (the cut), `crack` (each room), `clink` (tablet or slot), `zip` (spark, quiet), and an underground hum bed scaled by how open the cut is.

**Done:**
- With `?debug`, `relayqHill.debug()` returns `{xr, zc, open:[...], shown:{vault,queue,backoff,pit}, target:{...}, sparks}`.
- Playwright, desktop 1440×900:
  - C1: press "See inside". After 3.2 s: `zc === 12.5`, every `open === 1`, `aria-pressed="true"`, no console errors.
  - C2: Run 100 jobs while open. Within 15 s `shown.vault ≥ 20`. When the run settles (`target` unchanged for 3 s), `shown` deep-equals `target` within 3 s.
  - C3: press again. After 1.8 s `zc === 1000` and the pills are visible.
  - C4: rAF rate ≥ 60 fps over 2 s while sparks fly.
  - C5: with `reducedMotion: "reduce"`, one press gives `zc === 12.5` and every `open === 1` on the next frame.
- Screenshots reviewed: open, light, dark, 390×844.
- `npm run lint`, `npx tsc --noEmit` and `npx vitest run test/demo.test.ts` pass.

## Phase 16 — Demo hill: full view and an orderly queue

A run takes the whole window so the hill has room, and waiting boulders stand in a line instead of a heap.

**Files:** `public/demo/assets/hill.js` (`SLOTS`, `inLine`, the glide in `physics()`, `frameFor`, `stage`), `src/api/demo.ts` (`body.stage` CSS, `#exit`, `stage()` script, `hill.js?v=16`).

**Full view.**
- A successful Run with the window at least 700 px wide and not portrait adds `body.stage`. `.scene` becomes fixed full-window, `#batch` moves into it as a bottom-left card, and `#exit` shows and takes focus. The camera eases to `frameFor(true)` over 1.2 s.
- Esc or `#exit` reverses it: `#batch` goes back to `.copy`, `#exit` hides, and focus returns to `#run`.
- Narrow or portrait windows never stage. Reduced motion stages with no animation.

**Queue.**
- Waiting, grounded boulders that are `inLine` (past the slab's front edge, or on the meadow in front of it at `z > wid/2 + 0.6`) are sorted by `seq` and given `SLOTS[0..9]`. The front slot is (−1, 4), near the foot. Slots are 2.5 m apart in two rows, at z 4.0 and 7.6. The strip straight out from the slab (|z| < 3) stays clear, because new rocks roll off the slab there. `VIS = 10`.
- A slotted boulder slower than 0.8 m/s rolls to its slot at 2.2 m/s. It moves into the slot's row first, keeping clear of the slab, then slides along the row.
- While gliding it passes through any other waiting boulder. It rests once it reaches its slot, and a slotted boulder is never faded as stranded.
- The slab has a rim on its back and sides (`lip()`), so rocks leave only over the front edge.
- A collision impulse is capped at 4, so a rock falling onto another nudges it instead of launching it.
- F5 (`?debug`, 40 s after Run): `debug().strays` (rocks faded as stranded) is at most 2.

**Done** (Playwright, fresh context):
- F1, 1440×900: after Run, `body.stage` is set, `#exit` is `display:flex` and focused. Esc gives `stage` false, `#exit` `none`, focus `run`, and `#batch` back inside `.copy`.
- F2, 420×860: after a successful Run (`#msg` says "on their way"), `stage` is false.
- F3, with `?debug`: within 20 s of Run, a sample with ≥ 5 slotted boulders has all of them within 0.3 m of their slot, and no two slotted boulders closer than 2.0 m.
- F4: with `reducedMotion: "reduce"`, `stage` is true 0.4 s after Run and `#scene` has 0 running animations.
- C1 still holds in full view: "See inside" gives `zc === 12.5` with every room open.
- `npm run lint`, `npx tsc --noEmit` and `npx vitest run test/demo.test.ts` pass.

## Phase 17 — Demo hill: guided tour on Run

When a run starts in full view, the camera follows one job's path with a caption at each stop, then hands back to the wide view. The onboarding is the animation itself.

**Files:** `public/demo/assets/hill.js` (`TOUR`, `tour`, `tourStart`/`tourStop`/`tourStep`, `place()` uses `tour.pos`/`tour.look` while `tour.k`), `src/api/demo.ts` (`.tour` card CSS, `.scene.touring .tag.on`, `hill.js?v=18`).

**Stops** (look at `at` from `dist` m, swung `yaw`, raised `pitch * dist`; the pill `tag` lights up, the others dim to 0.3):

| # | title | at | dist | yaw | pitch | waits for |
|---|---|---|---|---|---|---|
| 1 | Jobs drop in | slab + (1, 2, 1) | 24 | −0.35 | 0.4 | |
| 2 | They wait in line | (−6, ground + 0.5, 3.5) | 26 | −0.1 | 0.6 | |
| 3 | A worker takes the front one | (1.5, ground + 1, 3) | 25 | −0.25 | 0.45 | a worker holding a boulder |
| 4 | Some slip | (6.5, ground + 1, 0) | 25 | 0.12 | 0.36 | `slipped` above its value at the start |
| 5 | Delivered | (FLAG_X − 1.5, ground + 1.8, 0) | 16 | −0.3 | 0.3 | `delivered` above its value at the start |

**Timing.**
- Each stop holds `HOLD = 4.6` s.
- A stop with a wait holds until 2.5 s after its event, but never past 2.5 × HOLD, because the hill only moves when the real queue does.
- Camera moves are two cascaded damped steps (rate 2.4/s), so each move eases in and out.
- After stop 5, the camera eases back to the full-view pose and `tour.k` drops to 0 after 3 s.

**Ending it early:** Skip tour, Esc (leaves full view), dragging the canvas, or See inside all stop the tour and hand the camera back.

**No tour when:** reduced motion is on, or the hill is already open.

**Phones and portrait windows** (no full view): the page calls `relayqHill.tour()` and scrolls `#scene` to the middle of the screen.
- While touring, the scene grows from 460 to 600 px (≤ 900 px wide), or from 400 to 540 px (≤ 640 px).
- The card sits at the bottom of the scene, full width and compact, and `.hud` hides.
- Shot distances scale by `max(1, 1.4 / aspect)` so each subject still fits.
- `hill.js?v=20`.

**Done** (Playwright 1440×900, fresh context, `?debug`):
- T1: 1.5 s after Run, `debug().tour` is `{i:0,k:1}`, `.tour` is visible and `#scene.touring` is set.
- T2: the stops advance 0→1→2→3→4→−1, then `k === 0`. Stops 1 and 2 last 4.6 s ± 0.5. No stop lasts more than 11.5 s ± 0.5.
- T3: Skip tour gives `i === -1` and the card hidden at once, and `k === 0` 3.2 s later.
- T4: Esc during the tour gives `stage` false, `i === -1` and `k === 0` 3.5 s later.
- T5: with reduced motion, Run gives `stage` true and `i === -1, k === 0`.
- T6, 390×844 mobile: Run leaves `stage` false and the tour runs 0→4→done. During it, `#scene` is 540 px tall and fully in view, with the card ≤ 140 px. Afterwards it's back to 400 px, and `scrollWidth === 390`.
- T7, 800×1100: Run gives `stage` false, the tour running, and `#scene` at 600 px.
- Screenshots of all five stops reviewed.
- `npm run lint`, `npx tsc --noEmit` and `npx vitest run test/demo.test.ts` pass.

---

## Out of scope
Cron/recurring jobs UI, multi-region, Kafka, custom queue implementation.

## Status
- [x] Phase 1 Enqueue API
- [x] Phase 2 Workers / retries / DLQ
- [x] Phase 3 Rate limits / priority
- [x] Phase 4 Observability
- [x] Phase 5 Docker / CI / AWS (AWS window ends 2026-10-18; HTTPS on AWS pending CloudFront verification)
- [x] Phase 6 Throughput
- [x] Phase 7 Outbox + chaos test
- [x] Phase 8 Tracing (RelayQ side: otel.test + Jaeger trace api→worker in compose. PulseBoard single-trace check pending its Phase 9; ADOT→X-Ray skipped, AWS window too short)
- [x] Phase 9 embed.batch
- [x] Phase 10 llm.complete: budgets, fallback, cost (server-side refusal fallbacks skipped; Haiku 5.5 cache-read price assumed)
- [x] Phase 11 ml.retrain + model registry (trainer runs via local `docker run`; ECS RunTask skipped. Verified against the real pulseboard-ml-eta image, 2026-10-13)
- [x] Phase 12 SSRF guard on outbound calls
- [x] Phase 13 LLM budgets and usage over HTTP
- [x] Phase 14 Token-protected /metrics
- [x] `POST /embed` (sync embeddings for interactive use: PulseBoard search query and duplicate check; bulk stays on `embed.batch`). `test/embed-api.test.ts` 3 pass.
- [x] Phase 15 Demo hill: "See inside" cutaway. Playwright 1440x900: C1 open state exact at 3.3 s, C2 vault 20 at 11.6 s and counts equal targets 5 ms after settle, C3 closed with pills back, C4 71 fps with 13 sparks, C5 reduced motion instant; light, dark and 390x844 reviewed.
- [x] Phase 16 Demo hill: full view and orderly queue (2026-10-16: slab rim, capped impulse and slots moved off the slab's exit, so strays per run fell from 16 of 31 landed to 0 of 16). F1 stage/exit/focus exact, F2 420x860 not staged, F3 7/7 in slot with min gap 2.4 m at 14 s, F4 reduced motion instant, C1 in full view; lint, tsc, demo tests pass.
- [x] Phase 17 Demo hill: guided tour on Run. T1 start state exact, T2 stops at 4.8/9.5/20.9/32.4 s then done at 42.5 s (stops 3 and 4 hit their cap: the local worker was clearing a test backlog), T3 skip, T4 Esc, T5 reduced motion; lint, tsc, demo tests pass.
- [x] Phase 17b Tour on phones and portrait windows (in the page). T6 390x844: tour done at 33.2 s, scene 540 px with a 127 px card, back to 400 px, no sideways scroll. T7 800x1100: tour running, scene 600 px. Desktop full view unchanged.
