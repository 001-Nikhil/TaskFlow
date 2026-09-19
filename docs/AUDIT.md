# TaskFlow — Audit

Last full verification: 2026-09-20. Commit refs are short hashes in this repo.
The original Phase 1 findings (25 items, all resolved) are kept in
`docs/AUDIT-phase1.md`; section 1 maps them to the fixing commits.

## 0. How this was verified (real commands, real output)

| Command | Result |
|---|---|
| `npm ci` (clean install) | 170 packages installed |
| `npm audit` | 0 vulnerabilities |
| `npm outdated` | nothing outdated |
| `npm run lint` (ESLint + Prettier --check) | clean |
| `npm test` (unit) | 5 / 5 passed |
| `npm run test:integration` (real Postgres, `taskflow_test`) | 22 / 22 passed |
| `npm run test:chaos` (real workers, real containers) | 12 / 12 passed |
| `docker compose up -d --build` | postgres, redis, api, worker all `healthy`; migrate exit 0 |
| `docker compose up -d --scale worker=3` + 80 jobs | 80/80 COMPLETED; claims 38/18/24 across the 3 workers; 0 jobs claimed twice |
| Migrations up → down 4 → up on an empty scratch DB | all succeed |

**Not verified / limits of these runs**

- `docker compose down -v` (true from-zero volume start) was **not** run: it
  deletes the dev database, which needs your approval. Migrations from
  empty were verified separately on a scratch database instead.
- In the compose scale test the queue drained in under 5 s, so the
  `docker kill` of one worker landed after most work was done. Crash
  recovery is proven by the chaos suite (real processes), not by that
  compose run.
- No load test (k6), no cloud deployment, no CI pipeline exists yet.
- Chaos tests use a hard process kill (`taskkill /F` on Windows, equivalent
  to `kill -9`) and `docker stop` for SIGTERM. Docker Desktop must be running.

## 1. Found and fixed

### This verification pass

| # | Sev | Finding | Fix (commit) |
|---|---|---|---|
| V1 | **CRITICAL** | Backoff delays were **1000× too short**: `failJob` passed `delayMs/1000` into SQL that divides by 1000 again. Retries fired almost instantly; jitter/backoff were effectively off. No test checked the real `run_at`. | `d7bc7eb` (regression test asserts real `run_at`; verified it fails on the old code) |
| V2 | **CRITICAL** | Worker and API **crashed** (uncaught exception) when Postgres dropped a connection on a *checked-out* client (e.g. DB failover mid-transaction). Pool `error` listener only covers idle clients. Found by chaos test #4 (worker exited code 1). | `fe48f6a` |
| V3 | **HIGH** | `max_attempts` was compared with `attempt`, the fencing token, so worker crashes, lease expiries and deploy/shutdown releases consumed the job's retry budget. | `d7bc7eb` (migration `failure_count`; tests) |
| V4 | **HIGH** | Reaper could steal a *live* job: it scanned expired leases, then `failJob` guarded only on `attempt`/`locked_by`, so a heartbeat landing in between still lost. | `d7bc7eb` (`recoverJob` re-checks `lease_expires_at < now()` inside the UPDATE; race tested) |
| V5 | **HIGH** | A crash-looping "poison" job would be retried forever once recoveries stopped costing budget. | `d7bc7eb` (`recovery_count`, `MAX_LEASE_RECOVERIES`, quarantine to DEAD) |
| V6 | **HIGH** | A DB error inside `completeJob`/`failJob` escaped the worker lane → `unhandledRejection` guard → whole worker `exit(1)`. | `ea42416` |
| V7 | **HIGH** | An error writing "completed" was caught by the handler `catch` and recorded as a **handler failure** (re-running a job that succeeded, spending budget). | `ea42416` |
| V8 | **HIGH** | Worker kept running the handler after losing its lease (side effects for a run that will be fenced off). | `ea42416` (abort on failed `extendLease`; chaos test) |
| V9 | **HIGH** | Worker did not release in-flight jobs when the shutdown grace period expired (job sat `PROCESSING` until lease expiry). | `ac7945b` |
| V10 | **HIGH** | Test suites wiped the **dev** database. | `6357928` (separate `taskflow_test`; guard refuses any DB not ending `_test`) |
| V11 | MEDIUM | `/ready` hung forever with Redis down (ioredis queues commands). | `ac7945b` |
| V12 | MEDIUM | `/ready` returned 503 when only Redis was down although nothing depends on Redis for correctness (would pull healthy instances from an LB). Now `ready:true, degraded:true`. | `4640d5c` |
| V13 | MEDIUM | `GET /jobs/:id` returned `SELECT *` (locked_by, lease_expires_at, …). | `4640d5c` |
| V14 | MEDIUM | API key compared with `!==` (timing side channel). Now SHA-256 digests + `timingSafeEqual`. | `4640d5c` |
| V15 | MEDIUM | `/health` and `/ready` were behind the per-IP rate limiter. | `4640d5c` |
| V16 | MEDIUM | Unknown routes / unexpected errors could return HTML or stack traces. | `4640d5c` |
| V17 | MEDIUM | Worker required `API_KEY` and `REDIS_URL` to start; env values not validated (NaN intervals); heartbeat could exceed lease. | `ea42416` |
| V18 | MEDIUM | No `CHECK` that a `PROCESSING` row has a lease (reaper could never see it). | `d7bc7eb` |
| V19 | MEDIUM | API/worker not containerised; compose incomplete. Now `migrate` one-shot, healthchecks, read-only rootfs, `cap_drop: ALL`, non-root, loopback-only ports, no secret defaults, `SHUTDOWN_GRACE_MS` 25 s < `stop_grace_period` 35 s. | `9a220d5`, `73e474a` |
| V20 | LOW | No ESLint/Prettier; CRLF/LF warnings; 3 unused imports. | `c37659e` |
| V21 | LOW | Docs did not state that external effects (email, payments) need provider-level idempotency keys; DESIGN lacked counters/reaper/DB-failure sections. | `84e13ef` |
| V22 | LOW | pg pool had no connection/idle timeouts or configurable size. | `fe48f6a` |

### Phase 1 findings (docs/AUDIT-phase1.md) → resolved by

| Phase 1 # | Resolved by |
|---|---|
| 1, 2 (idempotency column + race) | `6c68414`, `38417ca` |
| 3, 4, 5, 6 (job loss, stuck PROCESSING, dual write, blocking backoff) | `daa5023` (Postgres SKIP LOCKED claiming, reaper) |
| 7 (no fencing) | `15224a9` |
| 8 (unhandled pg/redis errors) | `2799c41` (+ `fe48f6a` for checked-out clients) |
| 9, 10, 11 (DEAD unused, no error classes, no jitter) | `15224a9`, `daa5023` |
| 12–15 (validation, UUID, response shape, SELECT *) | `38417ca` (+ `4640d5c`) |
| 16 (hard-coded credentials) | `10a6b0a` |
| 17 (graceful shutdown) | `daa5023`, `38417ca`, `ac7945b` |
| 18–25 (index, CHECKs, busy loop, naming, compose `version`, scripts) | `6c68414`, `daa5023`, `10a6b0a` |

## 2. Requirements you asked to verify

| Requirement | Status |
|---|---|
| Shutdown / lease-expiry must not consume retry budget; `attempt` stays the fencing counter; `failure_count` + migration + tests | **Done** (`d7bc7eb`). Note: lease-expiry has its *own* cap (`recovery_count`, default 10) so poison jobs cannot crash-loop forever. Say the word if you would rather have no cap. |
| Tests use `taskflow_test`, never dev DB | **Done** (`6357928`); proven with a canary row in the dev DB surviving a test run |
| Chaos #4, Postgres drop mid-job | **Done** (`fe48f6a`): single drop and a 5 s connection storm |
| Redis FLUSHALL/outage; "queued jobs restored by the reconciler" | **Verified, but there is no reconciler and none is needed**: Redis holds no job state (Postgres is the queue). Test: 5 QUEUED jobs, `FLUSHALL`, all 5 completed (`4640d5c`). See DESIGN.md. |
| Docs: external effects need provider-level idempotency keys | **Done** (`84e13ef`, also in `effects.js`) |
| Dependencies justified and current; audit clean | **Done**: section 4 |

## 3. Remaining (nothing omitted). Severity = risk if shipped as-is

### Correctness / reliability

| # | Sev | Item |
|---|---|---|
| R1 | MEDIUM | `ctx.once()` is claim-then-act: a crash between claim and effect can **miss** an effect (documented trade-off, DESIGN.md). Mitigation is provider keys + a STARTED/DONE ledger; not built. |
| R2 | MEDIUM | Strict priority ordering: sustained HIGH load starves LOW. No aging/weighted polling. |
| R3 | MEDIUM | A handler that ignores its `AbortSignal` keeps running after timeout while the lane claims the next job, so real concurrency can exceed `WORKER_CONCURRENCY`. Needs `worker_threads`/child-process isolation for untrusted handlers. |
| R4 | MEDIUM | No retention/archival: `jobs`, `job_events`, `effects`, `workers` grow forever; dead `workers` rows are never deleted. |
| R5 | LOW | A shutdown release still consumes an `attempt` number (cannot go back: it is the fencing token). Budget is unaffected. |
| R6 | LOW | Idempotency key is unique globally, not per tenant/type. |
| R7 | LOW | Redis is vestigial (only a `/ready` ping). Either give it a job (wake-up, rate-limit store) or remove it from compose. |
| R8 | LOW | `docker kill` (manual stop) is not auto-restarted by `restart: unless-stopped`; crash exits are. |

### API / product

| # | Sev | Item |
|---|---|---|
| P1 | HIGH (for a real product) | One shared API key; no per-tenant keys, hashing at rest, scopes, or per-tenant quotas. Rate limit is per-IP, in-memory per instance (needs `trust proxy` behind a load balancer, and a shared store to be global). |
| P2 | HIGH (feature gap) | No list/filter, cancel, batch submit, result storage, webhooks, cron, dependencies/DAGs, DLQ inspect/redrive/purge endpoints, `priority`/`delayMs`/`runAt` in the API. |
| P3 | MEDIUM | No per-job-type payload validation (only "is an object"), no OpenAPI spec, no `/v1` versioning. |

### Observability / operations

| # | Sev | Item |
|---|---|---|
| O1 | HIGH | No `/metrics`, Grafana, tracing, alerts or SLOs. Logs are plain `console` text, not structured, no correlation ids. |
| O2 | MEDIUM | No dashboard UI; no runbook. |

### Security

| # | Sev | Item |
|---|---|---|
| S1 | MEDIUM | Redis and Postgres inside the compose network have no TLS; Redis has no password (ports are loopback-only). |
| S2 | MEDIUM | No image scanning (Trivy), SAST, SBOM, or secrets manager; single DB superuser used by all processes (no least-privilege roles). |
| S3 | LOW | `.env` holds real secrets on disk (git-ignored). I appended `TEST_DATABASE_URL` to your local `.env`; it is not committed. |

### Engineering quality

| # | Sev | Item |
|---|---|---|
| Q1 | MEDIUM | No CI pipeline, no pre-commit hooks, no coverage thresholds; unit tests cover only backoff. |
| Q2 | LOW | Tests wipe tables in `taskflow_test`; do not run two suites against it concurrently (scripts already pass `--no-file-parallelism`). |
| Q3 | LOW | No load-test results (`docs/PERFORMANCE.md` does not exist; numbers must come from your machine). |
| Q4 | LOW | JavaScript, not TypeScript (decision pending). |

## 4. Dependencies (all current, `npm audit` = 0)

| Package | Why it is here |
|---|---|
| express 5, express-rate-limit | HTTP API and its per-IP limiter (hand-rolling either adds no learning value) |
| pg | Postgres driver; plain SQL is a design goal (no ORM) |
| node-pg-migrate | versioned up/down migrations |
| zod | request validation at the boundary |
| dotenv | local `.env` loading |
| ioredis | **only** the `/ready` ping today (see R7); justified only if Redis gets a real job |
| vitest, supertest | test runner and HTTP assertions |
| eslint, @eslint/js, globals, eslint-config-prettier, prettier | lint and format |

No queue library (BullMQ, pg-boss, …) by design: the queue, lease and retry
logic is the point of the project.
