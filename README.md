# RelayQ

Background-job service: apps `POST /jobs` over HTTP, BullMQ workers run them with retries,
exponential backoff, a dead-letter queue, per-tenant rate limits and idempotency.
First client: PulseBoard. Plan and contracts: [PLAN.md](PLAN.md).

## Run locally

```bash
docker compose up -d --build                                  # api :3000, 3 workers, redis, postgres, mailhog :8025, prometheus :9090, grafana :3001
docker compose exec api node dist/cli/create-key.js my-tenant # prints an rq_ key once
curl -X POST localhost:3000/jobs -H "authorization: Bearer rq_..." -H "content-type: application/json" \
  -d '{"type":"webhook.deliver","payload":{"url":"https://example.com/hook","body":{"hi":1}}}'
```

Tests (need Docker for Testcontainers): `npm test`.

## API

| Route | |
|---|---|
| `POST /jobs {type, payload, idempotencyKey?, delayMs?, priority?}` | `202 {jobId}`; same idempotency key within 24 h → `200` with the original id; `429` over 10,000 queued per tenant |
| `GET /jobs/:id` | `{id, type, status, attempts, result?, error?}` |
| `POST /jobs/:id/retry` | re-queue a `dead` job |
| `GET /metrics`, `GET /health` | Prometheus; `{redis, db}` |
| `/admin/queues` | bull-board, basic auth (`ADMIN_USER` / `ADMIN_PASSWORD`) |

Job types: `email.digest`, `board.export`, `webhook.deliver` (signed with `X-RelayQ-Signature`, hex HMAC-SHA256 of the body).

## Throughput (measured)

`docker compose --profile load run --rm k6`: 50 VUs enqueue `webhook.deliver` jobs to a local sink for 5 minutes, 3 workers.

| | |
|---|---|
| Jobs enqueued (202) | 167,133 (557/s) |
| Jobs completed | 167,133 in 300.0 s → **33,424 jobs/min** |
| Lost | **0** (`count(completed, dead) == enqueued`; 0 dead, 0 retries) |
| Enqueue latency | p95 **130.6 ms**, median 85.4 ms |

Setup: one laptop, Docker Desktop on Windows 11 (16 vCPU, 11 GiB to Docker), everything in compose.
3 workers × `WORKER_CONCURRENCY=5`; `TENANT_JOBS_PER_MIN` raised to 1,000,000 for the run (default 100 would cap it at 100/min).
Workers kept pace with enqueue the whole run (no backlog formed), so 33k/min is bounded by the enqueue side, a floor for worker capacity, not a ceiling.
