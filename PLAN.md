# RelayQ — PLAN

A standalone background-job service: other apps POST jobs over HTTP, BullMQ
workers run them with retries, backoff, rate limits and idempotency, and a
dashboard shows what's happening. First client: **PulseBoard** (`../pulseboard`).
**This file is the contract.** Each phase ends in a check that can fail.

Resume line this must earn:
> RelayQ — distributed job queue service (Node.js, TypeScript, BullMQ, Redis,
> PostgreSQL, Docker, AWS). Idempotent HTTP enqueue, exponential-backoff retries,
> dead-letter queue, per-tenant rate limits, Prometheus metrics; processes
> N jobs/min across 3 workers (measured).

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

- Per-tenant limit: BullMQ group/limiter, default 100 jobs/min per tenant; excess stays queued (not rejected).
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
- AWS: two ECS services (`relayq-api`, `relayq-worker` with autoscaling on `relayq_queue_depth`), ElastiCache, RDS, SES, S3. Secrets in SSM.

**Done:** CI green on `main`; `curl https://<prod>/health` → `200 {"redis":"ok","db":"ok"}`; PulseBoard's `POST /boards/:id/export` produces a downloadable S3 file end-to-end in prod.

## Phase 6 — Throughput number (the resume number)

- `load/enqueue.k6.js`: 50 VUs enqueue `webhook.deliver` jobs to a local sink for 5 minutes against 3 workers.

**Done:** record jobs/min completed and p95 enqueue latency in `README.md`; resume line uses the measured N, never a guessed one. Zero jobs lost: `count(JobRecord where status in (completed,dead)) == enqueued`.

---

## Out of scope
Cron/recurring jobs UI, multi-region, Kafka, custom queue implementation.

## Status
- [x] Phase 1 Enqueue API
- [ ] Phase 2 Workers / retries / DLQ
- [ ] Phase 3 Rate limits / priority
- [ ] Phase 4 Observability
- [ ] Phase 5 Docker / CI / AWS
- [ ] Phase 6 Throughput
