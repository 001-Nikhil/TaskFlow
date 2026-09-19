# Interview Q&A (draft: re-word every answer in your own voice)

Every answer below is true of the code as of 2026-09-20 and points at where to
show it. Do not memorise it; read the linked code, then say it your own way.
Numbers marked _(measure it)_ must come from a run you did yourself.

**1. What is the one thing this system guarantees?**
A worker can crash mid-job and the job is neither lost nor wrongly run twice.
Delivery is at-least-once; fencing keeps job _state_ consistent and an effects
ledger keeps side effects idempotent. Proof: `tests/chaos/worker-crash.test.js`
(real `kill -9`).

**2. Why not exactly-once?**
Impossible across independent failure domains: a worker can die between doing
the work and recording it. So: at-least-once + idempotent handlers. External
effects (payments, email) additionally need provider-side idempotency keys
(`docs/DESIGN.md`).

**3. How do two workers avoid taking the same job?**
`SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1` inside the same statement that
sets `PROCESSING` (`claimNextJob`). A locked row is skipped, not waited on.
Verified: 80 jobs across 3 workers, 0 double claims.

**4. Lease vs lock?**
A lock has a fixed expiry and nobody can tell if the holder is alive. A lease
must be extended by heartbeat; expiry _is_ the failure detector. It lives on the
job row (`locked_by`, `lease_expires_at`) so status and ownership cannot disagree.

**5. What is fencing and what bug does it prevent?**
`attempt` increases on every claim; every worker write is guarded
`WHERE status='PROCESSING' AND locked_by=$w AND attempt=$n`. A worker that stalled
past its lease and wakes up later matches zero rows, so it cannot overwrite the
new owner's result. Test: "zombie worker".

**6. Why is fencing not enough?**
It protects job _state_. The zombie may already have sent the email. That is the
second layer: `ctx.once()` effects ledger, plus provider idempotency keys.

**7. Why is Postgres the queue instead of Redis?**
Insert-then-push is a dual write; a crash between them loses jobs and no
ordering fixes it. Claiming from Postgres removes the second write, so a Redis
flush or outage cannot lose anything (tested). Cost: polling latency
(`POLL_INTERVAL_MS`, default 500 ms) and DB load; that is the trade-off.

**8. What does the reaper do and how does it avoid stealing live jobs?**
It finds `PROCESSING` rows with `lease_expires_at < now()` (database time, never
worker clocks) and returns them to the queue. The expiry check is repeated
inside the guarded `UPDATE`, so a heartbeat that lands after the scan wins.

**9. Do crashes use up a job's retries?**
No. `attempt` (fencing) ≠ `failure_count` (handler failures, the only thing
`max_attempts` limits). Lease-expiry recoveries have their own cap
(`recovery_count`) so a poison job that kills every worker is quarantined to
`DEAD`.

**10. How does retry backoff work?**
Exponential with full jitter, persisted as `run_at` on the row (`RETRY_SCHEDULED`),
so no worker sleeps and a dead worker cannot lose the retry. Injectable
`random` makes it unit-testable. Real bug I found: an extra `/1000` made delays
1000x too short; a test now asserts the actual `run_at`.

**11. What happens on SIGTERM?**
Stop claiming; let in-flight jobs finish within `SHUTDOWN_GRACE_MS`; if time runs
out, release them immediately (reason `shutdown`) instead of waiting out the
lease. `SHUTDOWN_GRACE_MS` (25 s) < Docker `stop_grace_period` (35 s).

**12. What happens if Postgres drops connections mid-job?**
pg emits `error` on a checked-out client; without a listener that is an uncaught
exception and the process dies (my chaos test found exactly that). Fixed with a
per-client listener. DB errors while recording the outcome leave the row
`PROCESSING` and the reaper recovers it.

**13. How do you make submission idempotent?**
`INSERT ... ON CONFLICT (idempotency_key) DO NOTHING RETURNING`, backed by a
UNIQUE constraint, then fall back to `SELECT`. Test: 10 concurrent identical
submissions produce exactly 1 job.

**14. What would you change to scale this 100x?**
Measure first _(measure it: k6)_. Likely: partition/retention for `jobs` and
`job_events`, PgBouncer and pool sizing, claim batching, LISTEN/NOTIFY or Redis
wake-ups instead of polling, per-queue concurrency, autoscaling workers on queue
depth. Kafka behind a `QueueDriver` is an option but loses per-message
priority. (`QueueDriver` interface is not built yet.)

**15. What are the known weaknesses?**
`ctx.once()` can miss an effect if the process dies between claim and effect;
strict priority can starve LOW jobs; a handler that ignores its `AbortSignal`
can exceed the concurrency limit; single shared API key, no metrics/tracing yet.
All listed in `docs/AUDIT.md` with severity. Saying this unprompted is a strength.
