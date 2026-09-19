# TaskFlow — Progress Log

## 2026-09-20

**Phase 1 (Audit) complete.** `docs/AUDIT.md` written: what worked, 25
flaws by severity with file:line references, everything missing vs. the
Section 4 checklist, and a prioritized fix plan. Also found and fixed an
environment issue unrelated to the code: git was rooted at the user's home
directory instead of the project folder — re-initialized correctly in this
project (user confirmed), and discovered + intentionally dropped a stale
Postgres dev volume with 23 test rows from an earlier manual-testing
session (user confirmed starting fresh).

**Phase 2 (fixes) in progress**, in priority order from the audit:

- [x] Process crashes from unhandled `pg`/`redis` `'error'` events
      (Audit #8) — `src/processGuards.js`, listeners on both clients.
- [x] Hardcoded credentials / no fail-fast config (Audit #16, Section 7) —
      `src/config.js`, `.env.example`, Redis AOF enabled in compose.
- [x] Migration tooling (`node-pg-migrate`) replacing first-run-only
      `init.sql`; baseline migration + the full Section 3 schema (leases,
      fencing, priority, run_at, backoff/timeout config, idempotency_key,
      job_events, workers, effects) + required indexes/constraints.
      Verified: migrate up/down/up round-trips clean against a live dev DB.
- [x] `src/jobs/` domain module: fencing-guarded claim/complete/fail
      (`repository.js`), backoff+jitter (`backoff.js`, 5 unit tests),
      error classes (`errors.js`), execution-idempotency ledger
      (`effects.js`), worker registry (`workerRegistry.js`).
- [x] Worker rewrite (Audit #3–#7): Postgres `SKIP LOCKED` claiming
      replaces Redis `BRPOP` entirely — closes both silent job-loss paths
      (crash between pop and PROCESSING; crash during the old blocking
      backoff sleep). Concurrency via N lanes, per-job lease heartbeat,
      timeout via `AbortController`, graceful SIGTERM/SIGINT shutdown,
      worker registry heartbeat independent of job execution (a real bug
      caught in manual testing — see the commit message). Verified
      end-to-end against the live dev stack, including SIGTERM inside an
      actual Linux container (Windows can't deliver real SIGTERM to test
      it directly).

- [x] API rewrite: idempotent submission (`INSERT ... ON CONFLICT`),
      zod validation, unknown-type rejection using
      `src/jobs/handlers.js`'s `KNOWN_JOB_TYPES`, UUID param validation,
      consistent response shape, `/health` + `/ready`, API key auth,
      payload size limit, rate limiting, graceful shutdown for the API
      process itself (Audit #1, #2, #9–#15, #17). Verified with an
      integration test against the live dev stack: 10 concurrent
      identical submissions produce exactly 1 job (5 tests, all passing).

This closes every CRITICAL and HIGH item from `docs/AUDIT.md`. What's
left is mostly net-new Phase 3 feature work plus the automated
chaos/load-test suite.

**Not started yet** (still to do, in the order planned):

- [ ] DLQ inspect/redrive/purge endpoints.
- [ ] Delayed/scheduled job support exposed at the API (`delayMs`/`runAt`
      already work at the DB/claim level — see docs/DESIGN.md).
- [ ] Priority starvation policy (weighted fair polling or aging) —
      priority ordering itself already works, starvation protection
      doesn't yet.
- [ ] Dashboard, `/metrics` (prom-client), Grafana dashboard JSON,
      OpenTelemetry.
- [ ] Integration tests (real Postgres+Redis): submit→complete,
      retry→DLQ, delayed jobs, idempotent-submission race, concurrent
      claim race.
- [ ] Chaos tests (Section 9's headline tests): kill -9 mid-job, lost ack,
      Redis flush/restart, Postgres connection drop mid-job, zombie
      worker fencing rejection, SIGTERM during a job.
- [ ] k6 load tests + `docs/PERFORMANCE.md` (needs the user to run these
      and report real numbers per CLAUDE.md — can't fabricate benchmarks).
- [ ] Containerize the API and worker in `docker-compose.yml` (currently
      only Postgres+Redis are in compose; API/worker run via bare `node`
      on the host, or were manually run via `docker run` for this
      session's SIGTERM test only).
- [ ] ESLint/Prettier.

See `docs/DESIGN.md` for the reasoning behind each completed piece, and
`docs/AUDIT.md` for the full original findings and fix plan this log is
tracking against.

## Phase 3, item 1: chaos tests (done)

`npm run test:chaos` (8 tests, real Postgres, real worker processes, real
containers for SIGTERM). All passing:

- kill -9 mid-job -> reaper reclaims, completes on attempt 2, effect once.
- Lost ack (killed after effect, before COMPLETED) -> redelivered, effect
  NOT repeated (effects ledger).
- Zombie worker with stale attempt -> complete/fail/extendLease all fenced.
- SIGTERM mid-job (worker in a container, `docker stop`) -> job completes,
  exit 0, worker STOPPED.
- SIGTERM with grace shorter than job -> job released as RETRY_SCHEDULED
  (reason=shutdown) immediately.
- Redis FLUSHALL and full Redis stop -> jobs still accepted and processed.

Bugs the tests found and fixed:
- Worker exited on grace expiry without releasing the in-flight job (job sat
  PROCESSING until lease expiry). Added `releaseJob` (CLAUDE.md 3.12).
- `/ready` hung forever when Redis was down (ioredis queues commands while
  disconnected). Dependency checks now time out after 2s and report 503.

Notes: the `chaos_effect` handler exists only when
`TASKFLOW_ENABLE_TEST_HANDLERS=1`. Chaos tests wipe jobs/effects/workers in
the dev DB, like the existing integration test. A shutdown release still
consumes an attempt number (attempt is the fencing token and can't go down).
Not covered yet: Postgres connection drop mid-job (chaos #4).
