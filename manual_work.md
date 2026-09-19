# manual_work.md — What is left, and what only YOU can do

Last updated: 2026-09-20 (after the full verification pass; see `docs/AUDIT.md`).
Statuses below were checked against the real code on that date, not assumed.

**How to read this file**

1. **"WHAT ONLY YOU MUST DO"** (next section) is your personal checklist.
2. **"RECOMMENDED ORDER OF EXECUTION"** tells you the next step at any moment.
3. **"REMAINING WORK"** has every roadmap item (R-01 … R-66) in one format.
4. Sections A–K afterwards are the older manual-only guides (accounts, secrets,
   AWS billing, demos, decisions), updated to match the code.

**Owner:** `CLAUDE` = I build it · `YOU` = only you can · `BOTH` = I prepare, you run/decide.
**Priority:** `P0` must have · `P1` should have · `P2` nice to have.
**Status:** `TODO` · `IN PROGRESS` (part exists) · `DONE`.
Installing tools/packages is not manual work; I do it (see CLAUDE.md, Installation Policy).

---

## WHAT ONLY YOU MUST DO

Tick these as you go. Each links to the item that explains it.

- [ ] Create the GitHub repository and push (unblocks CI) → **R-50**, section E
- [ ] Keep `.env` secrets strong and never commit them; rotate if ever exposed → section B
- [ ] Run the k6 load tests on your machine and paste the real numbers → **R-19**, **R-61**
- [ ] Watch the crash-recovery, graceful-shutdown and Redis-outage demos yourself once → section C
- [ ] Record the 2–3 minute demo video → **R-60**
- [ ] Write the README intro and the "problem / design / trade-offs / results" write-up in your own words → **R-53**, **R-62**
- [ ] Re-word the 15 interview answers in your voice and be able to draw the claim → lease → fence → reap flow → **R-63**
- [ ] Decide: TypeScript or stay JavaScript → **R-47**
- [ ] Decide: give Redis a real job or remove it → **R-65**
- [ ] Decide: retention period for finished jobs → **R-20**
- [ ] Decide: keep the poison-job cap (`MAX_LEASE_RECOVERIES=10`) or not → **R-25**
- [ ] AWS: create account, MFA, **billing alarm first**, least-privilege IAM, run `terraform apply` yourself, tear down after → **R-56**, **R-59**, section H
- [ ] Approve or refuse `docker compose down -v` for a true from-zero volume test (deletes dev data) → section L

---

## RECOMMENDED ORDER OF EXECUTION

P0 first. Do not skip ahead; later items assume earlier ones.

1. **R-53** README with architecture diagram (CLAUDE builds; YOU write the intro in your voice)
2. **R-30 + R-31 + R-55** `/metrics`, provisioned Grafana, Prometheus + Grafana in compose
3. **R-09** expose `priority` / `delayMs` / `runAt` in the API (columns already exist)
4. **R-17** priority aging + starvation test
5. **R-07, R-06, R-16** cancel, list/filter with cursor pagination, DLQ inspect/redrive/purge
6. **R-23** backpressure (max queue depth → 429 + `Retry-After`)
7. **R-50** CI (needs the GitHub repo from section E) + **R-49** coverage thresholds
8. **R-19** k6 scripts (CLAUDE) → you run → **R-61** real numbers into `docs/PERFORMANCE.md`
9. P1 block, in this order: **R-33** structured logs · **R-34** SLOs/alerts · **R-35** runbook · **R-01/R-02/R-03** keys, tenants, quotas · **R-04/R-05** OpenAPI, `/v1` · **R-10/R-11** results, webhooks · **R-13** DAG workflows · **R-20** retention · **R-52** ADRs · **R-46** threat model · **R-43/R-44** TLS, DB roles · **R-40** Trivy in CI
10. **R-60 + R-62 + R-63** demo video, write-up, interview answers (needs real numbers from step 8)
11. **R-56 + R-58 + R-59** AWS via Terraform, tested backup/restore, teardown (you, with my Terraform)
12. P2 block as time allows: R-08, R-12, R-14, R-15, R-22, R-26, R-27, R-28, R-29, R-32, R-36, R-41, R-42, R-47, R-51, R-57

---

## REMAINING WORK TO REACH PRODUCT-COMPANY STANDARD

### 1. API and product

- **R-01 — API keys: hashed at rest, with scopes**
  - Owner: CLAUDE
  - Priority: P1
  - Why it matters: one shared plaintext env key is a demo, not a product; interviewers ask how you'd revoke one customer.
  - What to do: `api_keys` table (id, tenant_id, sha256 hash, scopes[], created/revoked_at); middleware looks up the hash; scopes such as `jobs:write`, `jobs:read`, `dlq:admin`; admin endpoints to create/revoke (key shown once).
  - Done when: a revoked key gets 401; a `jobs:read` key gets 403 on `POST /jobs`; no plaintext key is stored; tests cover all three.
  - Status: IN PROGRESS (a single `API_KEY` env var, compared in constant time via SHA-256 digests; no table, no scopes)

- **R-02 — Multi-tenancy / namespaces**
  - Owner: CLAUDE
  - Priority: P1
  - Why it matters: real platforms serve many teams; isolation and per-tenant fairness are standard design questions.
  - What to do: `tenant_id` on `jobs`; idempotency uniqueness becomes `(tenant_id, idempotency_key)`; every read/list filters by the caller's tenant; claim can round-robin tenants.
  - Done when: tenant A cannot read, cancel or list tenant B's jobs (tested); same idempotency key in two tenants makes two jobs.
  - Status: TODO (no tenant concept; idempotency key is globally unique)

- **R-03 — Per-tenant rate limits and quotas**
  - Owner: CLAUDE
  - Priority: P1
  - Why it matters: one noisy tenant must not starve the others; also protects the DB.
  - What to do: rate limit keyed by API key/tenant (shared store: Redis or Postgres, so it works across API instances); daily job quota and max queued jobs per tenant; `429` with `Retry-After`.
  - Done when: exceeding the limit returns 429 + `Retry-After`; two API instances share one budget (tested with two processes).
  - Status: IN PROGRESS (100 req/min per IP, in-memory per instance, via express-rate-limit)

- **R-04 — OpenAPI spec plus request validation**
  - Owner: CLAUDE
  - Priority: P1
  - Why it matters: a documented contract is what makes an API usable by other teams and testable by contract tests.
  - What to do: generate `openapi.yaml` from the zod schemas (e.g. zod-to-openapi); serve Swagger UI at `/docs`; contract test that responses match the spec.
  - Done when: `/docs` renders every endpoint; CI fails if spec and implementation diverge.
  - Status: IN PROGRESS (zod validation on `POST /jobs` and UUID checks exist; no spec, no docs page)

- **R-05 — API versioning (`/v1`)**
  - Owner: CLAUDE
  - Priority: P2
  - Why it matters: lets you change the API without breaking clients.
  - What to do: mount routes under `/v1`; keep unversioned paths as deprecated aliases for one release; list it under "Breaking changes" in `CHANGELOG.md`.
  - Done when: all endpoints answer under `/v1/...`; old paths return `Deprecation` header.
  - Status: TODO

- **R-06 — List / filter / search jobs with cursor pagination**
  - Owner: CLAUDE
  - Priority: P0
  - Why it matters: any operator or customer needs to find jobs; offset pagination is the classic anti-pattern, keyset is the expected answer.
  - What to do: `GET /jobs?status=&type=&createdAfter=&limit=&cursor=`; keyset on `(created_at, id)`; return `nextCursor`; supporting index; cap `limit` at 100.
  - Done when: paging through 10k seeded rows returns each row exactly once with stable ordering; `EXPLAIN` shows an index scan (recorded in DESIGN.md).
  - Status: TODO (only `GET /jobs/:id` exists)

- **R-07 — Cancel a job**
  - Owner: CLAUDE
  - Priority: P0
  - Why it matters: cancellation vs a job that is already running is a good concurrency story (cooperative abort via lease).
  - What to do: `POST /jobs/:id/cancel`: `QUEUED`/`RETRY_SCHEDULED` → `CANCELLED` atomically with a guarded UPDATE; for `PROCESSING` set a cancel flag that the worker sees at its next heartbeat and aborts the handler; write `job_events`.
  - Done when: cancelling queued job prevents it ever running; cancelling a running job aborts it and ends `CANCELLED`; cancelling a finished job returns 409; all tested.
  - Status: TODO (the `CANCELLED` enum value exists; nothing uses it)

- **R-08 — Batch submit**
  - Owner: CLAUDE
  - Priority: P2
  - Why it matters: throughput; one round trip and one transaction for many jobs.
  - What to do: `POST /jobs/batch` (max 100), one multi-row `INSERT ... ON CONFLICT DO NOTHING`, per-item result (created / duplicate / invalid).
  - Done when: 100-item batch inserts in one transaction; duplicates reported per item; oversize batch returns 413.
  - Status: TODO

- **R-09 — Expose `priority`, `delayMs`, `runAt` in the API**
  - Owner: CLAUDE
  - Priority: P0
  - Why it matters: priorities and delayed jobs are core features already implemented in the DB and claim query but unreachable by clients.
  - What to do: extend the zod schema (`priority` HIGH/MEDIUM/LOW → 1/2/3; `delayMs` or `runAt` ISO, mutually exclusive, sane bounds, stored UTC); optional per-job `maxAttempts`, `timeoutMs` with upper caps.
  - Done when: a job with `delayMs: 5000` is not claimed for 5 s (tested); HIGH jobs are claimed before LOW; invalid/past-huge values return 400.
  - Status: TODO (claim ordering by `priority_rank` and `run_at <= now()` works; `POST /jobs` accepts neither field)

- **R-10 — Job result storage**
  - Owner: CLAUDE
  - Priority: P1
  - Why it matters: many clients need the output, not just "done"; forces a decision on size limits and retention.
  - What to do: handlers return a JSON result; store in `jobs.result` (size-capped, e.g. 64 KB, larger goes to a pointer); include in `GET /jobs/:id`; written in the same transaction as `COMPLETED`.
  - Done when: result visible after completion; oversize result fails the job non-retryably; result and status can never disagree (tested via chaos kill).
  - Status: TODO (no `result` column; handler return value is discarded)

- **R-11 — Webhook / callback on completion or failure**
  - Owner: CLAUDE
  - Priority: P1
  - Why it matters: classic outbox-pattern question (how do you deliver a notification exactly once-ish when the DB write and the HTTP call cannot be atomic?).
  - What to do: `callbackUrl` on submit; a `webhook_deliveries` outbox row written in the same transaction as the terminal transition; a dispatcher with retries, HMAC signature, SSRF protection (block private IPs).
  - Done when: completion produces exactly one delivery row; receiver down → retried with backoff → DLQ; signature verifiable; private-IP URLs rejected.
  - Status: TODO

- **R-12 — Recurring / cron jobs**
  - Owner: CLAUDE
  - Priority: P2
  - Why it matters: scheduling from several scheduler instances without double-firing is a standard leader-election / dedupe problem.
  - What to do: `schedules` table (cron expr, next_run_at); a tick uses `FOR UPDATE SKIP LOCKED` to fire due schedules and insert a job with idempotency key `schedule:<id>:<fire_time>`.
  - Done when: two scheduler processes over 10 minutes fire each occurrence exactly once (tested with a fast cron).
  - Status: TODO

- **R-13 — Job dependencies / DAG workflows**
  - Owner: CLAUDE
  - Priority: P1
  - Why it matters: this is what makes it a *workflow engine*, not just a queue; without it the project title over-claims.
  - What to do: `workflows` and `job_dependencies` tables; a job is created `WAITING`; on a parent's `COMPLETED` (same transaction) children whose parents are all done become `QUEUED`; parent `DEAD` → children `CANCELLED`; cycle detection at submit.
  - Done when: a 3-step diamond DAG runs in dependency order; killing a worker mid-step still finishes the DAG once; a cycle is rejected with 400.
  - Status: TODO

- **R-14 — Per-queue concurrency limits and rate limiting**
  - Owner: CLAUDE
  - Priority: P2
  - Why it matters: protects downstream APIs (e.g. max 5 concurrent email sends, 10/s).
  - What to do: named `queue` column; per-queue `max_concurrency` enforced in the claim query (count of `PROCESSING` per queue); token-bucket rate limit per queue.
  - Done when: with limit 2 and 10 slow jobs, never more than 2 run at once across 3 workers (tested).
  - Status: TODO (only per-worker `WORKER_CONCURRENCY`)

- **R-15 — Client SDK (npm package)**
  - Owner: CLAUDE
  - Priority: P2
  - Why it matters: shows API design from the consumer's side.
  - What to do: small `@taskflow/client` (submit, get, list, cancel, wait-for-completion) with retries + automatic idempotency keys; generated types from OpenAPI (needs R-04).
  - Done when: an example script submits and awaits a job using only the SDK; published (private) with tests.
  - Status: TODO

- **R-16 — DLQ inspect / redrive / purge, with audit log**
  - Owner: CLAUDE
  - Priority: P0
  - Why it matters: "what happens to jobs that keep failing?" is the first ops question about any queue.
  - What to do: `GET /dlq` (paged), `POST /dlq/:id/redrive` (DEAD → QUEUED, reset `failure_count`, `recovery_count`), `POST /dlq/redrive` (bulk by filter), `DELETE /dlq/:id` and purge; each action writes `job_events` and an `audit_log` row (who, what, when).
  - Done when: a DEAD job can be inspected, redriven and then succeeds; every action is in the audit log; redrive of a non-DEAD job returns 409.
  - Status: TODO (jobs do reach `DEAD` with the reason recorded in `job_events`; no endpoints)

### 2. Reliability and scale

- **R-17 — Priority aging + starvation test**
  - Owner: CLAUDE
  - Priority: P0
  - Why it matters: strict priority starves LOW under sustained HIGH load; naming the policy and proving it is a strong design answer (CLAUDE.md 3.8).
  - What to do: aging in the claim `ORDER BY` (effective rank improves with wait time) or weighted 6:3:1 selection; document the choice in DESIGN.md; test with continuous HIGH load.
  - Done when: under sustained HIGH submissions a LOW job still starts within a documented bound (tested).
  - Status: TODO (strict `priority_rank ASC, run_at, created_at`; see audit R2)

- **R-18 — Chaos tests complete**
  - Owner: CLAUDE
  - Priority: P0
  - Why it matters: this is the project's headline claim.
  - What to do: nothing further for the six scenarios in CLAUDE.md §9; optionally add "worker paused (SIGSTOP) then resumed" on Linux.
  - Done when: `npm run test:chaos` passes: kill -9, lost ack, zombie fencing, SIGTERM (finish and forced release), Postgres drop/storm, Redis flush/outage, lease loss.
  - Status: DONE (12/12 passing on 2026-09-20)

- **R-19 — k6 load-test scripts and report**
  - Owner: BOTH
  - Priority: P0
  - Why it matters: "measured" beats "designed"; you must be able to state throughput, latency percentiles and backlog-drain time.
  - What to do: CLAUDE writes `tests/load/submit.js` and a drain-time script and adds `docker run grafana/k6` commands. YOU run them (1, 3, 6 workers) and paste the real output plus machine specs into `docs/PERFORMANCE.md`.
  - Done when: `docs/PERFORMANCE.md` has p50/p95/p99 submit latency, jobs/s, and drain time for 1/3/6 workers, with your hardware listed. No invented numbers.
  - Status: TODO (`tests/load/` is empty)

- **R-20 — Retention, archival and partitioning**
  - Owner: BOTH
  - Priority: P1
  - Why it matters: an unbounded `jobs`/`job_events` table is the most common real-world queue failure.
  - What to do: YOU choose retention (e.g. COMPLETED 7 days, events 30 days); CLAUDE adds a batched delete job (small batches, no long locks) and evaluates monthly range partitioning on `created_at`; also delete stale `DEAD` worker rows.
  - Done when: a seeded 1M-row table shrinks to the retention window without blocking claims (measured); documented in DESIGN.md.
  - Status: TODO

- **R-21 — Connection-pool sizing and PgBouncer**
  - Owner: CLAUDE
  - Priority: P1
  - Why it matters: (workers × pool) can exceed Postgres `max_connections`; standard scale question.
  - What to do: document the formula; add PgBouncer (transaction mode) to compose and verify the claim/fence queries work through it (no session state used); pool size per role.
  - Done when: 10 workers run through PgBouncer with < 30 server connections; tests pass through it.
  - Status: IN PROGRESS (`PG_POOL_MAX`, connection/idle timeouts exist; no PgBouncer, no sizing doc)

- **R-22 — Autoscale workers on queue depth**
  - Owner: BOTH
  - Priority: P2
  - Why it matters: shows operational thinking (KEDA / ECS target tracking on a queue-depth metric).
  - What to do: expose queue depth metric (R-30); define a scaling rule (workers = depth / target-per-worker) for ECS or KEDA; YOU apply it in AWS (R-56).
  - Done when: a 10k-job burst scales workers up and back down within the configured bounds (observed in Grafana).
  - Status: TODO

- **R-23 — Backpressure at the API**
  - Owner: CLAUDE
  - Priority: P1
  - Why it matters: an unbounded queue just moves the outage; CLAUDE.md §3.13 requires it.
  - What to do: reject submits with `429` + `Retry-After` when queued jobs exceed `MAX_QUEUE_DEPTH` (cheap cached count) or the tenant quota (R-03).
  - Done when: above the limit submits get 429; below it they succeed again (tested).
  - Status: IN PROGRESS (256 KB body limit → 413 and per-IP rate limit exist; no queue-depth limit)

- **R-24 — Zero-downtime deploys / rolling restarts**
  - Owner: CLAUDE
  - Priority: P1
  - Why it matters: deploys must not lose or duplicate jobs.
  - What to do: script a rolling restart (`docker compose up -d --no-deps --scale`); test that restarting workers one by one under load loses nothing and completes every job once; API rolls behind the healthcheck.
  - Done when: a test submits continuously while all workers and the API restart; final state: all jobs `COMPLETED`, none duplicated.
  - Status: IN PROGRESS (graceful shutdown, release-on-timeout and `stop_grace_period` > grace are implemented and chaos-tested; the full rolling-restart scenario is not)

- **R-25 — Poison-job quarantine**
  - Owner: BOTH
  - Priority: P1
  - Why it matters: one job that crashes every worker must not take the fleet down.
  - What to do: implemented; YOU decide whether to keep the cap (default 10). Optionally alert on `poison_quarantined` (R-34).
  - Done when: a job whose lease expires more than `MAX_LEASE_RECOVERIES` times ends `DEAD` with reason `poison_quarantined` (tested); non-retryable handler errors go straight to `DEAD` (tested).
  - Status: DONE (commit `d7bc7eb`; decision pending from you)

- **R-26 — Kafka adapter behind a `QueueDriver` interface**
  - Owner: CLAUDE
  - Priority: P2
  - Why it matters: shows you can abstract the transport; also shows you know Kafka has no per-message priority.
  - What to do: first extract a `QueueDriver` (`enqueue, claim, ack, nack, extendLease, depth`) around today's Postgres claiming; write an ADR (YOU decide replace vs add); then a Kafka driver with priority as separate topics.
  - Done when: the same integration and chaos suites pass against both drivers.
  - Status: TODO (claiming lives directly in `src/jobs/repository.js`; no interface)

- **R-27 — Optional Go worker**
  - Owner: CLAUDE
  - Priority: P2
  - Why it matters: demonstrates the DB contract is language-neutral.
  - What to do: Go worker implementing claim/heartbeat/complete/fail against the same SQL.
  - Done when: a mixed Node + Go fleet passes the chaos suite.
  - Status: TODO

- **R-28 — Handler isolation for untrusted/CPU-heavy code**
  - Owner: CLAUDE
  - Priority: P2
  - Why it matters: Node cannot kill an async function; a handler ignoring `AbortSignal` can exceed concurrency limits (audit R3).
  - What to do: run such handlers in `worker_threads`/child processes that can be terminated on timeout.
  - Done when: a handler that ignores its signal is hard-terminated at `timeout_ms` and the lane is free again with no leaked work (tested).
  - Status: TODO

- **R-29 — Effects ledger with STARTED/DONE states**
  - Owner: CLAUDE
  - Priority: P2
  - Why it matters: removes the "claimed but never performed" missed-effect window (audit R1) for handlers that can verify with the provider.
  - What to do: record `STARTED` then `DONE`; on redelivery of a `STARTED` effect call an optional `verify()` hook instead of skipping blindly.
  - Done when: crash between claim and effect results in the effect being performed (or verified done) exactly once (chaos test).
  - Status: TODO (claim-then-act only; documented limitation, plus provider idempotency keys are documented as required for real external effects)

### 3. Observability and operations

- **R-30 — Prometheus `/metrics`**
  - Owner: CLAUDE
  - Priority: P0
  - Why it matters: you cannot operate or autoscale what you cannot measure.
  - What to do: prom-client on API and worker; at least `jobs_submitted_total`, `jobs_completed_total`, `jobs_failed_total{type}`, `jobs_retried_total`, `jobs_dead_total`, `job_duration_seconds`, `queue_depth{priority}`, `jobs_processing`, `workers_active`, `lease_expired_total`, `duplicate_deliveries_total`.
  - Done when: `curl /metrics` shows all of them; values move when jobs run (tested).
  - Status: TODO

- **R-31 — Provisioned Grafana dashboard**
  - Owner: CLAUDE
  - Priority: P0
  - Why it matters: turns metrics into the picture you show in the demo.
  - What to do: Prometheus + Grafana services in compose; provisioned datasource and dashboard JSON committed (throughput, queue depth, latency percentiles, retries, DLQ, workers, lease expiries).
  - Done when: `docker compose up` shows a populated dashboard with no manual clicks. (YOU then verify it against real traffic, section F.)
  - Status: TODO

- **R-32 — OpenTelemetry traces**
  - Owner: CLAUDE
  - Priority: P2
  - Why it matters: one trace from API to worker is the canonical distributed-systems demo.
  - What to do: store `traceparent` on the job at submit; worker continues the trace; Jaeger/Tempo in compose.
  - Done when: one job shows spans API → claim → handler → complete in the UI.
  - Status: TODO

- **R-33 — Structured logs with correlation ids**
  - Owner: CLAUDE
  - Priority: P1
  - Why it matters: `console.log` text cannot be searched or joined across processes.
  - What to do: pino JSON logs with `jobId`, `workerId`, `attempt`, `requestId`; never log payloads or secrets; request-id middleware.
  - Done when: every log line is JSON; one `jobId` grep follows a job from API to worker; a test asserts no payload appears in logs.
  - Status: TODO (plain `console.*` everywhere)

- **R-34 — SLOs and alert rules**
  - Owner: BOTH
  - Priority: P1
  - Why it matters: alerts on symptoms (queue lag, DLQ growth), not on CPU, are what on-call actually needs.
  - What to do: YOU pick targets (e.g. 99% of jobs start within 30 s); CLAUDE writes Prometheus alert rules: queue lag, DLQ growth, no active workers, lease-expiry spike, poison quarantine.
  - Done when: `promtool check rules` passes; a forced worker outage fires the alert in the demo stack.
  - Status: TODO

- **R-35 — Runbooks**
  - Owner: CLAUDE
  - Priority: P1
  - Why it matters: shows you think about the 3 a.m. case.
  - What to do: `docs/RUNBOOK.md`: DLQ growing, workers down, queue lag, DB failover, Redis down, redrive procedure, how to read `job_events`.
  - Done when: each alert from R-34 links to a runbook section with concrete commands.
  - Status: TODO (`docs/RUNBOOK.md` does not exist)

- **R-36 — Dashboard UI with auth / RBAC**
  - Owner: CLAUDE
  - Priority: P2
  - Why it matters: usable product surface; RBAC (viewer vs admin) is a security talking point.
  - What to do: small static UI over the API (counts, jobs table, DLQ actions); login; roles viewer/operator/admin.
  - Done when: viewer cannot redrive; operator can; unauthenticated users see nothing.
  - Status: TODO

- **R-37 — Audit log of administrative actions**
  - Owner: CLAUDE
  - Priority: P1
  - Why it matters: "who redrove or purged what" is a compliance basic.
  - What to do: `audit_log` table written in the same transaction as each admin action (cancel, redrive, purge, key create/revoke).
  - Done when: every admin endpoint leaves an audit row with actor; rows cannot be edited through the API.
  - Status: IN PROGRESS (`job_events` records every job state transition with worker and reason; there is no log of API-caller actions)

### 4. Security

- **R-38 — Secrets management**
  - Owner: BOTH
  - Priority: P1
  - Why it matters: env files on disk are fine locally but not for production.
  - What to do: CLAUDE keeps config env-only (already) and documents the secret list; YOU store production secrets in AWS Secrets Manager/SSM and inject them into ECS (R-56).
  - Done when: no secret in the repo or images (`gitleaks`/`trufflehog` scan clean in CI); production reads secrets from the manager.
  - Status: IN PROGRESS (nothing hard-coded; compose fails fast without `POSTGRES_PASSWORD`/`API_KEY`; no secret scanning, no manager)

- **R-39 — Non-root, hardened containers**
  - Owner: CLAUDE
  - Priority: P1
  - Why it matters: baseline container security.
  - What to do: already done; keep it working when new services are added.
  - Done when: `docker exec ... id` shows `node` (not root); rootfs read-only; capabilities dropped.
  - Status: DONE (`USER node`, `read_only`, `cap_drop: ALL`, `no-new-privileges`, multi-stage image without dev dependencies)

- **R-40 — Image and dependency scanning**
  - Owner: CLAUDE
  - Priority: P1
  - Why it matters: supply-chain hygiene is a standard review item.
  - What to do: Trivy scan of the image and `npm audit --audit-level=high` in CI; Dependabot config.
  - Done when: CI fails on a HIGH/CRITICAL finding; scan results visible in the pipeline.
  - Status: IN PROGRESS (`npm audit` = 0 vulnerabilities run by hand on 2026-09-20; not automated, no Trivy)

- **R-41 — SAST**
  - Owner: CLAUDE
  - Priority: P2
  - Why it matters: catches injection/unsafe patterns automatically.
  - What to do: CodeQL or Semgrep in CI with the JS rulesets.
  - Done when: scan runs on every PR and blocks on high severity.
  - Status: TODO

- **R-42 — SBOM**
  - Owner: CLAUDE
  - Priority: P2
  - Why it matters: increasingly required by enterprise customers.
  - What to do: generate CycloneDX SBOM (`npm sbom` or syft) in CI and attach to releases.
  - Done when: an SBOM artifact is produced for each build.
  - Status: TODO

- **R-43 — TLS**
  - Owner: BOTH
  - Priority: P1
  - Why it matters: no plaintext credentials or job payloads on the wire.
  - What to do: CLAUDE configures Postgres/Redis TLS options and a TLS-terminating proxy in the prod-like compose; YOU obtain the certificate (ACM/domain) for AWS (R-56).
  - Done when: API only reachable over HTTPS in the deployed environment; API↔Postgres connection uses TLS (`sslmode=require`).
  - Status: TODO

- **R-44 — Least-privilege database users**
  - Owner: CLAUDE
  - Priority: P1
  - Why it matters: a compromised API should not be able to `DROP TABLE`.
  - What to do: roles: `migrator` (DDL), `app` (DML on needed tables only), `readonly` (dashboards); apps connect as `app`.
  - Done when: as `app`, `DROP TABLE jobs` fails (tested); all suites pass with the restricted role.
  - Status: TODO (every process uses the single database superuser)

- **R-45 — Input and payload limits (per-type validation)**
  - Owner: CLAUDE
  - Priority: P1
  - Why it matters: bounded inputs are the first line of defense.
  - What to do: add per-job-type payload zod schemas in the handler registry; invalid → 400 at submit.
  - Done when: `send_email` without a valid `to` is rejected at submission, not at run time.
  - Status: IN PROGRESS (256 KB body limit → 413, zod on the envelope, UUID validation, unknown type → 400, parameterized SQL only; payload contents are not validated per type)

- **R-46 — Threat model note**
  - Owner: BOTH
  - Priority: P1
  - Why it matters: shows structured security thinking (STRIDE-lite).
  - What to do: CLAUDE drafts `docs/THREAT_MODEL.md` (assets, trust boundaries, threats, mitigations, residual risk); YOU review and edit.
  - Done when: each threat maps to a mitigation in the code or a listed residual risk.
  - Status: TODO

### 5. Engineering quality

- **R-47 — TypeScript decision**
  - Owner: YOU
  - Priority: P2
  - Why it matters: many companies expect TS; migrating late is costly and CLAUDE.md forbids doing it without asking.
  - What to do: decide yes/no; if yes I migrate incrementally (`allowJs`) module by module.
  - Done when: decision recorded in an ADR (R-52).
  - Status: TODO (JavaScript CommonJS)

- **R-48 — ESLint and Prettier**
  - Owner: CLAUDE
  - Priority: P0
  - Why it matters: baseline hygiene; must gate CI.
  - What to do: nothing more; wire into CI (R-50) and pre-commit (R-51).
  - Done when: `npm run lint` passes on a clean checkout.
  - Status: DONE (`eslint.config.js`, `.prettierrc.json`, `npm run lint`; clean on 2026-09-20)

- **R-49 — Test pyramid and coverage thresholds**
  - Owner: CLAUDE
  - Priority: P0
  - Why it matters: coverage numbers plus the right kinds of tests show engineering discipline.
  - What to do: add unit tests for effects (`once`), config validation, worker helpers; contract tests against the OpenAPI spec (R-04); enable vitest coverage with thresholds (e.g. 80% lines on `src/jobs`); keep chaos and load separate.
  - Done when: `npm run test:coverage` fails below the thresholds; CI runs all of unit/integration/contract.
  - Status: IN PROGRESS (unit 5, integration 22, chaos 12, all passing; no contract tests, no coverage measurement, unit tests only cover backoff)

- **R-50 — CI pipeline (GitHub Actions)**
  - Owner: BOTH
  - Priority: P0
  - Why it matters: "it passes on my machine" is not evidence; CI is table stakes.
  - What to do: YOU create the GitHub repo (section E); CLAUDE writes `.github/workflows/ci.yml`: install, lint, unit, integration (Postgres + Redis service containers, `taskflow_test`), chaos where possible, docker build, Trivy, `npm audit`.
  - Done when: a PR shows a green pipeline; a deliberately broken test turns it red.
  - Status: TODO (no `.github/`)

- **R-51 — Pre-commit hooks**
  - Owner: CLAUDE
  - Priority: P2
  - Why it matters: catches lint and secrets before they reach CI.
  - What to do: husky + lint-staged (eslint, prettier) and a secret scan.
  - Done when: committing a badly formatted file or a fake secret is blocked locally.
  - Status: TODO

- **R-52 — ADRs (architecture decision records)**
  - Owner: CLAUDE
  - Priority: P1
  - Why it matters: shows decisions and their trade-offs were deliberate.
  - What to do: `docs/ADR/NNNN-*.md` for: Postgres-primary claiming, leases + fencing, three counters, no ORM, Node/JS, Redis role (R-65), TypeScript (R-47).
  - Done when: each major decision has an ADR with context, options, decision, consequences.
  - Status: TODO (`docs/ADR/` does not exist; reasoning currently lives in `docs/DESIGN.md`)

- **R-53 — README with architecture diagram**
  - Owner: BOTH
  - Priority: P0
  - Why it matters: it is the first (often only) thing a reviewer reads.
  - What to do: CLAUDE writes the structure: what it is, Mermaid architecture + sequence diagram (claim/lease/fence/reap), key decisions, how to run, how to run tests and chaos tests, trade-offs and limitations. YOU rewrite the intro and "what I learned" in your own words.
  - Done when: a stranger can run `docker compose up --build`, submit a job and run the tests from the README alone; the intro is your own writing.
  - Status: IN PROGRESS (README.md written 2026-09-20 with diagrams, decisions, run/test instructions, limitations; you still need to rewrite the intro in your own words, marked with a TODO comment)

- **R-54 — `docs/DESIGN.md` with trade-offs**
  - Owner: CLAUDE
  - Priority: P1
  - Why it matters: explains the "why" for every design choice.
  - What to do: keep it current as features land; add EXPLAIN findings (R-66).
  - Done when: every implemented invariant has a "why" section; trade-offs are explicit.
  - Status: DONE for what exists (at-least-once, Postgres-primary, leases, fencing, effects ledger + provider keys, three counters, reaper guard, DB-failure rules, backoff, Redis today); grows with each feature

### 6. Deployment

- **R-55 — Docker Compose, production-like, local**
  - Owner: CLAUDE
  - Priority: P0
  - Why it matters: one command to run the system is what reviewers try first.
  - What to do: add Prometheus, Grafana (R-30/31) and optionally PgBouncer (R-21) to compose; keep `--scale worker=N` working.
  - Done when: `docker compose up --build` gives API, workers, DB, Redis, metrics and dashboards, all healthy.
  - Status: IN PROGRESS (postgres, redis, one-shot `migrate`, api, worker with healthchecks, hardening and graceful-stop timings; `--scale worker=3` verified; no metrics stack)

- **R-56 — Terraform for AWS**
  - Owner: BOTH
  - Priority: P1
  - Why it matters: shows real deployment ability, not just localhost.
  - What to do: CLAUDE writes Terraform (ECS Fargate or EKS, RDS Postgres, ElastiCache if Redis stays, ALB + ACM TLS, CloudWatch, Secrets Manager, security groups closed to the internet except the ALB) and a cost estimate. YOU create the account (section H), read `terraform plan`, run `apply`, and tear down.
  - Done when: `terraform apply` yields a reachable HTTPS endpoint that processes jobs; `terraform destroy` removes everything.
  - Status: TODO

- **R-57 — CI/CD deploy**
  - Owner: BOTH
  - Priority: P2
  - Why it matters: automated, repeatable releases.
  - What to do: pipeline builds and pushes the image to ECR and updates the ECS service; YOU configure OIDC role trust (no long-lived AWS keys in GitHub).
  - Done when: merging to `main` deploys with a rolling, zero-loss update (R-24).
  - Status: TODO

- **R-58 — Database backup and restore, tested**
  - Owner: BOTH
  - Priority: P1
  - Why it matters: an untested backup is not a backup.
  - What to do: CLAUDE writes `pg_dump`/restore scripts and the RDS snapshot config; YOU perform one real restore and verify job counts.
  - Done when: a restore into a fresh database reproduces the job counts; steps documented in the runbook (R-35).
  - Status: TODO

- **R-59 — Cost controls and teardown**
  - Owner: YOU
  - Priority: P1
  - Why it matters: an idle cloud demo can cost real money.
  - What to do: billing alarm before anything is created; use small instance sizes; schedule/scale-to-zero where possible; `terraform destroy` after each demo; check the bill the next day.
  - Done when: the budget alarm exists, resources are destroyed, and the next-day bill shows near zero.
  - Status: TODO

### 7. Portfolio and interview

- **R-60 — Demo video (2–3 min)**
  - Owner: YOU
  - Priority: P1
  - Why it matters: shows the system working; recruiters watch videos more than they read code.
  - What to do: record: submit jobs, `docker kill` a worker mid-job, watch the Grafana dashboard, show it complete once. (Needs R-31 for the dashboard.)
  - Done when: video is linked from the README.
  - Status: TODO

- **R-61 — Measured benchmarks**
  - Owner: YOU
  - Priority: P0
  - Why it matters: resume claims need real numbers.
  - What to do: after R-19, copy your own measured results into `docs/PERFORMANCE.md` and your resume with hardware noted.
  - Done when: every number in README/resume appears in `docs/PERFORMANCE.md` with how it was measured.
  - Status: TODO

- **R-62 — "Problem, design, trade-offs, results" write-up**
  - Owner: BOTH
  - Priority: P1
  - Why it matters: this is what you narrate in an interview.
  - What to do: CLAUDE provides an outline from `docs/DESIGN.md` and `docs/AUDIT.md`; YOU write it in your own voice with your real results.
  - Done when: a 1–2 page write-up exists in `docs/WRITEUP.md`, written by you.
  - Status: TODO

- **R-63 — 15 interview questions with short answers**
  - Owner: BOTH
  - Priority: P1
  - Why it matters: rehearsed, project-specific answers separate you from tutorial-followers.
  - What to do: draft exists; YOU re-word each answer and add the real numbers from R-19.
  - Done when: you can answer each without reading it, and can point to the code and test that proves it.
  - Status: IN PROGRESS (draft written: `docs/INTERVIEW_QA.md`, 15 Q&A grounded in this repo; not yet in your words; benchmark numbers marked "measure it")

### 8. Extra items found during verification

- **R-64 — Retention of the `effects` and `workers` tables**
  - Owner: CLAUDE
  - Priority: P2
  - Why it matters: both grow without bound today (audit R4).
  - What to do: delete `effects` with their job (already cascades) and prune `DEAD`/`STOPPED` worker rows older than N days in the retention job (R-20).
  - Done when: `workers` row count stays bounded after 1000 worker restarts (tested).
  - Status: TODO

- **R-65 — Decide Redis's role**
  - Owner: YOU
  - Priority: P2
  - Why it matters: today Redis costs an extra service and does nothing but a health ping (audit R7).
  - What to do: choose one: (a) use it for worker wake-ups and the shared rate-limit store (R-03); (b) remove it from compose and code. I implement your choice and write the ADR.
  - Done when: Redis either has a tested job or is gone.
  - Status: TODO (Redis is only pinged by `/ready`; outage tested as "degraded, not down")

- **R-66 — Seed script and query-plan evidence**
  - Owner: BOTH
  - Priority: P1
  - Why it matters: "I verified the index is used at 1M rows" is a much stronger claim than "I added an index".
  - What to do: CLAUDE writes `scripts/seed.js` (1M rows) and records `EXPLAIN (ANALYZE, BUFFERS)` for the claim, reaper and list queries in DESIGN.md; YOU run it and read the plans (section C).
  - Done when: DESIGN.md contains the real plans showing index scans on the claim and reaper queries.
  - Status: TODO (the indexes exist: `idx_jobs_claimable`, `idx_jobs_processing_lease`, `idx_jobs_status_created`; not yet verified with data)

---

# Manual-only guides (accounts, secrets, watching, decisions)

Legend: 🔴 blocks work · 🟡 needed soon · 🟢 later / optional

## A. Machine-level things I can't do from a terminal 🟡

Docker is already working on your machine (the stack has been running).

- [ ] **Docker resource limits** (Docker Desktop → Settings → Resources): at least 4 GB RAM and 2 CPUs so Postgres, Redis, several workers, and later Prometheus/Grafana run comfortably (GUI setting).
- [ ] Git identity is set (`git config user.name` currently `001-Nikhil`); change it only if you want a different name/email on commits.
- [ ] Type your `sudo` / admin password if I ever ask; I never store or guess it.

## B. Secrets and environment 🔴

- [ ] `.env` exists locally (git-ignored). Confirm with `git check-ignore .env` (should print `.env`).
- [ ] Use strong, unique values for `POSTGRES_PASSWORD` and `API_KEY` (`openssl rand -hex 32`). Keep `POSTGRES_PASSWORD` alphanumeric: compose embeds it in a URL.
- [ ] `.env` needs `TEST_DATABASE_URL` (I appended it on 2026-09-20). Compare with `.env.example` after pulling changes.
- [ ] If any secret was ever committed: **rotate it** (deleting it from the file does not remove it from git history).
- [ ] When Grafana arrives (R-31): set `GRAFANA_ADMIN_PASSWORD` yourself.

## C. Verify things by actually watching them 🟡

You must see these once with your own eyes; that is where the interview story comes from.

- [ ] **Crash recovery.** `docker compose up -d --scale worker=3`, submit jobs (slow ones are easiest via the chaos handler in tests, or a large batch), then `docker kill <worker-container>`. Note: a `docker kill`ed container is *not* auto-restarted (Docker treats it as a manual stop); a crash is. Watch the job wait for lease expiry (≤ `LEASE_MS`), get reclaimed by another worker, and complete once. Note how long recovery took.
- [ ] **Graceful shutdown.** `docker compose stop worker` mid-job → the job finishes, worker exits 0 (`docker compose logs worker` shows "Shutdown complete").
- [ ] **Lost ack.** There is no manual flag for this. Run `npm run test:chaos` and read the "lost ack" test and its output: the effect count is 1 while `attempt` is 2.
- [ ] **Redis wipe.** `docker compose exec redis redis-cli FLUSHALL` while jobs are queued → they still complete. There is **no reconciler**, by design: Redis holds no job state (`docs/DESIGN.md`). Dev stack only.
- [ ] **Query plans.** After R-66 exists: run the seed script and `EXPLAIN (ANALYZE, BUFFERS)` the claim query; confirm it uses `idx_jobs_claimable`.
- [ ] After R-30/31: compare Grafana numbers with what you submitted.

## D. Load testing 🟡 (R-19, R-61)

- [ ] Run the k6 scripts I write, on your machine (`docker run grafana/k6 ...` needs no install).
- [ ] Paste the real output and your hardware (CPU, RAM, Docker limits) into `docs/PERFORMANCE.md`. Never use numbers you did not measure.
- [ ] Scale workers 1 → 3 → 6 and note where the bottleneck moves (CPU, PG connections, API).

## E. Source control and repo settings 🟡

- [ ] Create the GitHub repo (private first).
- [ ] `git remote add origin <url> && git push -u origin main`
- [ ] Branch protection on `main` (PR + passing CI) once R-50 exists.
- [ ] Enable Dependabot alerts and secret scanning (Settings → Code security).
- [ ] Add CI secrets only if a workflow needs them (prefer OIDC over stored keys, R-57).

## F. Observability checks 🟡 (after R-30 / R-31 / R-32)

- [ ] Open Grafana (port from compose), log in with your password.
- [ ] Data source test is green; the provisioned dashboard shows live data while jobs run.
- [ ] If tracing is added: one job's trace shows API → claim → handler → complete.

## G. Kafka phase 🟢 (R-26)

- [ ] Decide whether Kafka replaces or sits beside the Postgres-based claiming (I will write the trade-off ADR; you decide).
- [ ] Accept the limitation: Kafka has no per-message priority (separate topics instead).
- [ ] Give Docker enough memory or choose Redpanda; MSK on AWS costs real money.

## H. AWS / cloud deployment 🟢 (R-56, R-57, R-58, R-59)

- [ ] Create the AWS account; **MFA on the root user**.
- [ ] **Billing alarm/budget first** (e.g. $10) before creating anything.
- [ ] IAM role/user with least privilege for deploys; never use root keys; `aws configure` locally.
- [ ] Choose region and services (ECS Fargate or EKS, RDS Postgres, ElastiCache only if Redis stays, ALB, CloudWatch); check pricing and free-tier limits.
- [ ] Read `terraform plan`, then run `terraform apply` yourself.
- [ ] Production secrets in Secrets Manager/SSM, not in the repo.
- [ ] RDS automated backups on, and one real restore performed.
- [ ] DB and Redis security groups must NOT be open to `0.0.0.0/0`.
- [ ] Domain/ACM certificate if you want a public HTTPS URL.
- [ ] `terraform destroy` when done; check the bill the next day.

## I. Your own understanding and portfolio 🟡 (R-53, R-60, R-62, R-63)

- [ ] Explain each concept in `docs/DESIGN.md` out loud without notes: at-least-once, idempotency, lease, fencing token, the three counters, backoff + jitter, `SKIP LOCKED`, why Postgres is the queue. If you cannot, ask me to teach it with a smaller example.
- [ ] Read the core path line by line and be able to draw it: `claimNextJob` → handler → `completeJob`/`failJob`; `extendLease`; `reapExpiredLeases`/`recoverJob` (`src/jobs/repository.js`, `src/worker.js`).
- [ ] Write the README intro and the "problem / what I learned / trade-offs" section yourself.
- [ ] Record the 2–3 minute crash-recovery demo.
- [ ] Interview one-liner: *"My worker can crash mid-job and the system recovers without losing or double-processing it. Here is how, and here is the test that kills it."*
- [ ] Put the project on your resume/LinkedIn with real, measured numbers only.

## J. Decisions only you can make 🟡

Already decided (recorded so nobody re-asks): Vitest is the test runner; Postgres-primary claiming with Redis off the correctness path; no queue library (BullMQ/pg-boss) as the engine; plain SQL, no ORM.

Still open:
- [ ] TypeScript vs staying in JavaScript (R-47)
- [ ] Redis: give it a job or remove it (R-65)
- [ ] Priority policy: weighted 6:3:1 vs aging (R-17). I recommend aging
- [ ] Default retry policy (currently `max_attempts` 4, backoff base 2 s, cap 300 s, timeout 30 s per job)
- [ ] Retention period for finished jobs and events (R-20)
- [ ] Keep the poison-job cap `MAX_LEASE_RECOVERIES=10`? (R-25)
- [ ] Whether and when to do the Go worker (R-27) and Kafka (R-26)

## K. Ongoing hygiene 🟢

- [ ] Periodically `npm audit` and `npm outdated` (currently 0 vulnerabilities, nothing outdated); read changelogs before major bumps.
- [ ] Rotate API keys/passwords if ever exposed.
- [ ] Before any risky experiment, back up the dev DB: `docker compose exec postgres pg_dump -U <user> <db> > backup.sql`
- [ ] Review `docs/AUDIT.md` "Remaining" section monthly.

## L. Claude-added items

_(I append new manual tasks here with date, why it is manual, exact steps, and what I do after.)_

- [ ] **2026-09-20: approve or decline a true from-zero start.** Why manual: `docker compose down -v` deletes the dev database volume; I will not run it without your OK. Steps: if you agree, tell me and I run `docker compose down -v && docker compose up -d --build` and re-verify migrations and smoke tests. Migrations were already verified up/down/up on a scratch database.
- [ ] **2026-09-20: review the `.env` change.** I appended `TEST_DATABASE_URL` to your local `.env` so tests use `taskflow_test`. Nothing else in `.env` was changed. Run `npm run test:db:setup` once on any new machine.
- [ ] **2026-09-20: decide the poison-job cap** (see R-25). Default: a job whose lease expires 10+ times is quarantined to `DEAD`. Say "no cap" if you prefer infinite recovery.
