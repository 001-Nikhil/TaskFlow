# TaskFlow — Audit (Phase 1)

Date: 2026-09-20
Scope: everything under the repo root except `node_modules/`.

## 0. Environment finding (blocking, not a code issue)

**The git repository root is `C:\Users\NIKHIL THAKUR` (the Windows user profile directory), not the project folder.**

```
git rev-parse --show-toplevel  ->  C:/Users/NIKHIL THAKUR
git rev-parse --git-dir        ->  C:/Users/NIKHIL THAKUR/.git
```

`.git` was apparently initialized one level above `Desktop`, not inside `task_flow_claude`. There are 0 commits so far, so nothing has been lost, but as configured:

- `git status` / `git add -A` from inside the project walks the **entire home directory** (`.ssh/`, `AppData/`, browser profiles, `NTUSER.DAT`, etc. all show up as untracked).
- Any commit made "in this project" would actually commit into a repo whose root is your whole profile. A careless `git add -A` here could stage SSH keys or other secrets.
- The project's own `.gitignore` only protects paths relative to the project folder's own tree if the repo root *is* that folder — right now it's just one ignore file among everything else in the home directory tree, so it doesn't fully protect against this.

**I have not run `git add` or `git commit` anywhere, and won't until this is resolved.** This needs your decision — see the question below. Nothing else in this audit depends on it, so the rest of Phase 1 proceeds normally.

---

## 1. What exists and works

- **`POST /jobs` happy path (no idempotency key)** — inserts a row, pushes to Redis, updates to `QUEUED`. Works end to end against the current (incomplete) schema.
- **`GET /jobs/:id`** — returns the row or 404. Works for well-formed UUIDs.
- **Worker main loop** — `BRPOP` → lock → fetch → run handler → mark `COMPLETED`/retry/`FAILED`. Works for the single-worker, no-crash, no-restart case.
- **Retry loop with exponential backoff (no jitter)** — successfully retries up to `max_retries` and eventually marks `FAILED`.
- **Two example handlers** (`send_email`, `process_image`) — simple, side-effect-free demonstration handlers.
- **Docker Compose for Postgres + Redis** — starts, has healthchecks, uses a named volume for Postgres.
- **`init.sql` core table** — reasonable base columns, uses `TIMESTAMPTZ` correctly, has an enum type and a status index.
- **`.gitignore`** — correctly ignores `node_modules/`, `.env*` (with an allow for `.env.example`), logs, build output. `node_modules/` is present on disk but (per `git ls-files`) not tracked — consistent with the gitignore, module.export/require patterns are consistent CommonJS throughout.

## 2. What exists but is flawed

Ordered by severity. File:line references are to the current file contents.

### CRITICAL

1. **`idempotency_key` column does not exist in the schema, so `POST /jobs` is broken for any client that sends one, and the "already broken" duplicate‑detection path is dead code.**
   `src/api.js:19` (`SELECT ... WHERE idempotency_key = $1`) and `src/api.js:30` (`INSERT INTO jobs (... idempotency_key)`) reference a column that `init.sql` never defines. Every request that includes `idempotencyKey` will throw a Postgres "column does not exist" error, caught by the generic `catch` at `src/api.js:44-54` and returned as a bare 500. Requests **without** an idempotency key insert successfully, meaning idempotent submission does not work at all today.

2. **Check-then-insert race for idempotency (TOCTOU).** `src/api.js:18-29` selects for an existing key, then inserts at `src/api.js:30` if nothing was found. Two concurrent requests with the same key can both pass the `SELECT` before either `INSERT` commits, producing two jobs for one idempotency key. The `catch` block at `src/api.js:45-49` tries to handle a `23505` unique-violation, but there is no unique constraint in the schema to ever raise one — so even the fallback doesn't fire. This is Section 3.6 item 1 in CLAUDE.md, unimplemented.

3. **Job loss window: `BRPOP` removes the job from Redis before any durable state says it's being worked.** `src/worker.js:39` pops the job id off the list, and the DB is only updated to `PROCESSING` two steps later at `src/worker.js:67`. If the process is killed (`kill -9`, OOM, host reboot) between these two lines, the job is gone from both the Redis list and — because Postgres still shows it `QUEUED` — nothing will ever notice or re-drive it. There is no reaper, no lease, no lease-expiry handling anywhere in the codebase.

4. **Jobs stuck forever in `PROCESSING` on any crash during handler execution.** Once `src/worker.js:67` sets `PROCESSING`, nothing times that state out. If the worker dies while `handler(job.payload)` (`src/worker.js:75`) is running, the row stays `PROCESSING` permanently — no `lease_expires_at`, no reaper process exists to reclaim it.

5. **Dual-write with no recovery path (API side).** `src/api.js:30` inserts, `src/api.js:34` pushes to Redis, `src/api.js:36` updates to `QUEUED` — three separate steps, no transaction, no outbox, no dispatcher/reconciler. A crash between insert and `LPUSH` leaves a job permanently `PENDING`, invisible to any worker, forever. A crash between `LPUSH` and the status `UPDATE` leaves a job that Redis will actually process, but Postgres will still show `PENDING` even after it completes (because the worker later does `UPDATE ... WHERE id = $1` unconditionally, so it will eventually get overwritten to `PROCESSING`/`COMPLETED` — but there's no guarantee the row exists yet if insert wasn't durably committed... it is committed by this point, so this specific sub-case self-heals, but the PENDING-forever case does not).

6. **Retry backoff blocks the worker and can silently lose the job.** `src/worker.js:112` does `await sleep(backoffDelay)` **inside the single worker loop**, so the worker processes nothing else while waiting (violates Section 3.7 / 3.13 — one worker = one job at a time with blocking backoff, no concurrency). Worse: at `src/worker.js:108` the DB status is set to `QUEUED` **before** the sleep and before the re-`LPUSH` at `src/worker.js:113`. If the worker crashes during the `sleep`, Postgres permanently shows `QUEUED` but the job was never pushed back to Redis — a silent, permanent job loss identical in effect to bug #3.

7. **No fencing/guarded updates anywhere — classic zombie-worker overwrite bug.** Every status transition in `src/worker.js` (lines 67, 77, 108, 118) and `src/api.js` (line 36) is an unconditional `UPDATE jobs SET status = ... WHERE id = $1`, never `WHERE status = 'PROCESSING' AND locked_by = $2 AND attempt = $3`. There is no `locked_by`, `attempt`, or `lease_expires_at` column at all. A worker whose Redis lock (`src/worker.js:48`) expired after 30s while still running (no heartbeat/lease-extension exists) can still complete its `UPDATE` and silently clobber whatever a second worker did with that job in the meantime. This directly violates Section 3.4.

8. **`pg.Pool` has no `'error'` listener.** `src/db.js` creates the pool but never calls `pool.on('error', ...)`. node-postgres emits `'error'` on the pool when an idle client hits a connection-level error (e.g., the DB restarts, network blip). An `EventEmitter` `'error'` event with no listener throws and **crashes the whole Node process** — meaning a transient Postgres hiccup can kill the API or worker outright, taking down every in-flight job with it. Same missing-listener issue for the `ioredis` client in `src/redis.js` (no `.on('error', ...)`), and there is no global `process.on('unhandledRejection', ...)` anywhere (required by CLAUDE.md Section 7), so any rejected promise not already inside a `try/catch` also kills the process.

### HIGH

9. **`DEAD` (the DLQ state) is defined in the enum but never used.** `src/worker.js:118` sets `FAILED` on terminal failure instead of `DEAD`. There is no DLQ API (inspect/redrive/purge) at all.

10. **All errors are treated as retryable, including programmer errors.** `src/worker.js:72-74` throws a plain `Error` for an unknown job type, and that error is caught by the same generic retry handler as a transient failure (`src/worker.js:83-121`). An unknown-type or malformed-payload job will retry `max_retries` times pointlessly before landing on `FAILED`, instead of going straight to the DLQ. No `RetryableError`/`NonRetryableError` distinction exists (Section 3.7, Section 7).

11. **No exponential backoff jitter.** `src/worker.js:103`: `BASE_DELAY * Math.pow(2, retry_count)` is pure exponential with no randomization — a thundering-herd risk if many jobs fail together (Section 3.7 requires jitter).

12. **No input validation beyond `type` truthiness.** `src/api.js:9-15` checks `type` is present but never checks it against the handler registry (unknown types are accepted at submission and only fail later, in the worker), never validates `payload` shape/size, and there's no zod (or any) schema validation anywhere in the repo.

13. **`GET /jobs/:id` will throw on a malformed UUID.** `src/api.js:62` passes `req.params.id` straight into a `WHERE id = $1` against a `uuid` column with no format check first; Postgres raises `invalid input syntax for type uuid`, which falls into the generic `catch` (`src/api.js:71-76`) and returns a bare 500 instead of 400.

14. **Inconsistent response shape.** The duplicate-submission response uses `jobid` (`src/api.js:25`) while the success response uses `jobId` (`src/api.js:40`) — same field, different casing, both undocumented.

15. **`SELECT *` on `GET /jobs/:id`** (`src/api.js:62`) returns every internal column (`error_message`, `retry_count`, etc.) with no auth or field filtering. There is no API auth of any kind on any route.

16. **Hardcoded default credentials** in three places: `src/db.js:5`, `scripts/test-connection.js:7`, and `docker-compose.yml:9` (`taskflow_user` / `taskflow_password`). No `.env.example` exists anywhere, and no `dotenv`-style env loading is wired up even if a `.env` were created.

17. **No graceful shutdown anywhere.** Neither `src/api.js` nor `src/worker.js` registers a `SIGTERM`/`SIGINT` handler. Killing either process (including a normal `docker compose stop` or `Ctrl+C`) abandons in-flight work with no attempt to finish, release locks, or mark state for retry (Section 3.12).

### MEDIUM

18. **`init.sql` index has no `IF NOT EXISTS`.** `init.sql:23` (`CREATE INDEX idx_jobs_status ...`) will error if the script is ever re-run against an existing database (e.g., manually, or after a migration tool starts managing schema).

19. **No `CHECK` constraints** on `retry_count`, `max_retries`, or their relationship — nothing stops `retry_count` from exceeding `max_retries` or going negative via a manual update.

20. **Busy-loop risk on Redis failure.** In `src/worker.js`, if `redis.brpop` (line 39) itself throws (e.g., Redis connection dropped), `jobId` stays `null`, and the outer `catch` (`src/worker.js:84`) just `continue`s with no delay — this can hot-loop and hammer Redis with reconnect attempts instead of backing off.

21. **`processed_at` is set on processing *start*, not completion, and is never distinguished per attempt.** `src/worker.js:67` sets `processed_at = NOW()` when the job is picked up, which is a misleading name/semantic and gets silently overwritten on every retry attempt.

22. **Duplicated connection-setup code.** `scripts/test-connection.js` re-implements the same `Pool`/`Redis` construction already in `src/db.js` / `src/redis.js` instead of reusing them — harmless today, but will drift.

23. **`docker-compose.yml` uses the obsolete top-level `version: '3.8'` key** (`docker-compose.yml:1`) — Compose V2 ignores it and warns.

### LOW

24. **`package.json` has no `start`/`dev`/real `test` script and no `engines` field.** The stub `"test": "echo ... && exit 1"` (`package.json:7`) would fail CI if wired up as-is.
25. Personal Hinglish comment in `scripts/test-connection.js:35` — harmless, not a defect.

## 3. What is missing entirely (vs. Section 4 checklist)

Everything below has **zero** implementation in the repo today:

- `job_events` audit table and any centralized `transition()` function (Section 3.3)
- `locked_by` / `attempt` / `lease_expires_at` / `priority_rank` / `run_at` columns (Section 3.4, 3.8, 3.9)
- `workers` table, heartbeat, dead-worker detection, reaper (Section 3.11, 3.4)
- Reconciler/sweeper to restore Redis state from Postgres after a flush/restart (Section 3.1)
- Transactional outbox or `FOR UPDATE SKIP LOCKED` claiming (Section 3.1, 3.5)
- Execution-level idempotency helper / `effects` table (Section 3.6.2)
- DLQ inspect / redrive / purge endpoints (Section 3.7, checklist #6)
- Delayed / scheduled jobs (`delayMs`, `runAt`) (Section 3.9, checklist #7)
- Priority queues + starvation policy (Section 3.8, checklist #8)
- Per-job/per-type timeout + `AbortSignal` handling, `worker_threads` isolation for untrusted handlers (Section 3.10)
- `WORKER_CONCURRENCY`, max queue depth, payload size limit, rate limiting (Section 3.13)
- `QueueDriver` interface abstraction (currently Redis calls are inlined directly in `api.js`/`worker.js`)
- Migration tool + baseline migration (currently only a first-run-only `init.sql`)
- zod validation, pino structured logging, `RetryableError`/`NonRetryableError` classes, injected clock/random for deterministic backoff tests (Section 7)
- `/health`, `/ready`, `/metrics` endpoints; Prometheus metrics; Grafana dashboard JSON; OpenTelemetry tracing (Section 8)
- Dashboard UI (checklist #12)
- Any tests at all — no unit, integration, chaos, or load tests exist; no test framework is installed
- `docs/DESIGN.md`, `docs/PROGRESS.md`, `docs/RUNBOOK.md`, `docs/ADR/`, `migrations/`, `tests/` — none of these paths exist yet
- API/worker containerization (they currently run on the host via bare `node`, not in Compose)
- Redis AOF persistence (`appendonly yes`) — not set in `docker-compose.yml`
- `.env.example`

## 4. Key risks if shipped as-is

- **Silent, permanent job loss** via two independent paths: crash between `BRPOP` and `PROCESSING` (worst case), and crash during retry backoff sleep (#3, #4, #6 above). Neither is detectable without manually querying the DB for stuck `PROCESSING`/`QUEUED` rows.
- **Double processing / lost updates** from the total absence of fencing (#7) — once any lease/heartbeat mechanism is added elsewhere, a zombie worker can still overwrite a completed job today.
- **Process crashes from unhandled `'error'` events** on the PG pool and Redis client (#8) turn ordinary transient network issues into full outages.
- **Idempotent submission is currently non-functional** (#1, #2) — the feature CLAUDE.md calls out as a named risk is not just incomplete, it 500s.
- **No visibility**: no `/health`/`/ready`, no metrics, no dashboard — an operator cannot tell the system is stuck without querying Postgres by hand.
- **Unauthenticated, unvalidated API** surface (#12, #15, #16) is not safe to expose beyond localhost.

## 5. Prioritized fix plan (Phase 2)

Order chosen so nothing is built on top of a broken foundation:

1. **Migrations tool + baseline migration** reproducing current schema, then a first real migration adding: `idempotency_key` (unique), `locked_by`, `attempt`, `lease_expires_at`, `priority_rank`, `run_at`, `RETRY_SCHEDULED` status, `job_events` table, `workers` table, `effects` table, plus the indexes from Section 6. Data migration mapping existing `FAILED` semantics is moot (no real data exists yet) but will be written for completeness/documentation.
2. **Add `pool.on('error')` / redis `.on('error')` / global `unhandledRejection` handler** — cheap, prevents whole-process crashes; do this before anything else touches these modules.
3. **Rebuild claiming around Postgres `FOR UPDATE SKIP LOCKED` as the atomic claim**, with Redis kept as a wake-up/notification signal — closes the `BRPOP`-then-crash job-loss hole (#3) and the dual-write hole (#5) at the same time, per Section 3.1/3.5. This is the biggest structural change in the project; flagged below for your go-ahead since it changes internal queue mechanics (not the public API).
4. **Add leases + fencing** (`locked_by`, `attempt`, `lease_expires_at`), guard every transition with `WHERE status = X AND attempt = Y AND locked_by = Z`, centralize transitions in one `transition()` helper that also writes `job_events`.
5. **Reaper** (finds expired `PROCESSING` leases → `RETRY_SCHEDULED`/`DEAD`) and **reconciler/sweeper** (restores Redis from Postgres after a flush).
6. **Fix idempotency**: `INSERT ... ON CONFLICT DO NOTHING RETURNING` + fallback `SELECT`, backed by the new unique constraint; add the execution-level `effects` helper and demonstrate it in `send_email`.
7. **Non-blocking backoff with jitter**, retryable-vs-non-retryable error classes, `RETRY_SCHEDULED` as the resting state, DLQ + redrive/purge API.
8. **Worker concurrency control, heartbeat/`workers` table, graceful shutdown (`SIGTERM`), per-job timeout/`AbortSignal`.**
9. **API hardening**: zod validation, unknown-type rejection at submission, UUID param validation, consistent response shape, `/health`/`/ready`, basic API-key auth, payload size limit, rate limiting.
10. Then Phase 3 features: delayed jobs, priority + starvation policy, dashboard, `/metrics` + Grafana JSON, chaos tests.

Each step above will be its own commit(s) with tests, per Section 10.

## 6. Corrected Section 0.1 snapshot

The original CLAUDE.md snapshot (Section 0.1) was accurate on every point checked against the real code — no corrections needed there. The one thing it did not and could not know about is the git-repository-root issue in Section 0 of this document, which is an environment/tooling issue, not a code issue.
