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

---

## Out of scope
Cron/recurring jobs UI, multi-region, Kafka, custom queue implementation.

## Status
- [x] Phase 1 Enqueue API
- [x] Phase 2 Workers / retries / DLQ
- [x] Phase 3 Rate limits / priority
- [x] Phase 4 Observability
- [x] Phase 5 Docker / CI / AWS (AWS window ends 2026-10-15; HTTPS on AWS pending CloudFront verification)
- [x] Phase 6 Throughput
- [x] Phase 7 Outbox + chaos test
- [x] Phase 8 Tracing (RelayQ side: otel.test + Jaeger trace api→worker in compose. PulseBoard single-trace check pending its Phase 9; ADOT→X-Ray skipped, AWS window too short)
- [x] Phase 9 embed.batch
- [x] Phase 10 llm.complete: budgets, fallback, cost (server-side refusal fallbacks skipped; Haiku 5.5 cache-read price assumed)
- [x] Phase 11 ml.retrain + model registry (trainer runs via local `docker run`; ECS RunTask skipped. Trainer stdout contract in src/worker/handlers/ml.retrain.ts, PulseBoard ml/eta still to implement it)
