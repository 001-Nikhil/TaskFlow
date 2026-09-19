# TaskFlow — Design Notes

This is the "why", not the "what" — the code comments explain what a given
line does; this document explains the distributed-systems concept behind
each design decision, so you can explain it in an interview without looking
at the code.

## At-least-once delivery, not exactly-once

Exactly-once delivery is not achievable in a system with independent
failure domains (worker process, network, database) — any point where a
worker could crash between "did the work" and "recorded that it did the
work" creates a window where the record either never happens (job lost) or
happens twice (job redelivered). TaskFlow does not pretend otherwise: it
guarantees **at-least-once delivery** (a job will be attempted until it
either completes or is exhausted/rejected) and asks handlers to be
**idempotent** (safe to run more than once). At-least-once delivery +
idempotent execution = "effectively-once" effects, which is the strongest
guarantee actually achievable without a two-phase commit across every
external system a handler might touch (email providers, payment APIs,
etc. — most of which don't support 2PC anyway).

Concretely: a worker can crash *after* successfully running a handler but
*before* the `COMPLETED` write commits. The job's lease will expire, the
reaper will reclaim it, and another worker will run the handler again.
This is not a bug — it is the "lost ack" scenario, and it's why execution
idempotency (below) exists.

## Postgres is the source of truth; the claim is Postgres-only

The original design pushed a job id onto a Redis list (`LPUSH`) after
inserting it into Postgres — two separate writes to two separate systems,
with no transaction spanning them. A crash between the two leaves a job
that exists in Postgres but was never pushed to Redis (lost forever,
invisible to any consumer), or a job pushed to Redis whose Postgres row
hadn't committed yet. This is the classic **dual-write problem**: it
cannot be fixed by ordering the writes differently, only by removing one
of the writes or making them atomic.

CLAUDE.md's Section 3.1 offers two fixes: a transactional outbox (insert
job + `PENDING` in one transaction; a separate dispatcher moves
`PENDING → QUEUED` and pushes to a queue; a sweeper redrives stale
`PENDING` rows), or **Postgres-only claiming**: skip the second system
entirely and have workers claim directly from Postgres with
`FOR UPDATE SKIP LOCKED`. TaskFlow uses the second option. Redis is not on
the correctness path for claiming: a job's status lives only in
`jobs.status`, so a Redis flush, restart, or total outage cannot lose a
job or duplicate one — there's nothing in Redis to lose. This also means
the classic "reconciler restores queue from Postgres after Redis flush"
chaos test is trivially satisfied by construction, rather than requiring a
separate reconciler process. Redis stays in the stack (with AOF enabled)
as an infrastructure placeholder for a future low-latency wake-up signal
(so workers don't have to poll on a fixed interval) or a future Kafka
swap-in behind a `QueueDriver` interface — neither is built yet.

The trade-off: pure polling means claim latency is bounded by
`POLL_INTERVAL_MS` (default 500ms) instead of being push-driven. For a
learning/portfolio project this is the right trade: it's simpler, it's
easier to reason about correctness, and 500ms of added latency doesn't
matter for background jobs.

## Leases (visibility timeout) instead of locks

A plain lock (`SET NX PX 30000` in the old Redis-based design) has no way
to say "this lock is still valid because the holder is still alive and
working" — it just has a fixed expiry. If the job takes longer than the
TTL, the lock silently expires while the worker is still running, and
nothing detects that. A **lease** is the same idea with the missing part
added back: the holder must periodically **extend** it (a heartbeat) to
prove it's still alive, and the *lease itself* — not a separate boolean —
is the authority on whether the claim is still valid. TaskFlow's lease
lives directly on the job row (`locked_by`, `lease_expires_at`) rather
than in a separate cache key, because the row is what a reaper needs to
scan anyway, and keeping it there means the lease and the job status can
never disagree about which worker owns the job.

`HEARTBEAT_INTERVAL_MS` (default: `LEASE_MS / 3`) is deliberately much
shorter than `LEASE_MS` (default 30s) so a single missed heartbeat tick
(a slow GC pause, a brief network blip) doesn't cost the lease.

## Fencing: the zombie-worker problem

A lease can still expire out from under a worker that is, in fact, still
running — a long GC pause, a paused container, a network partition that
heals. When it comes back, it doesn't know its lease was reclaimed, and it
will try to write `COMPLETED` (or `FAILED`) as if nothing happened. If a
second worker has since claimed the same job (because the reaper moved it
back to `RETRY_SCHEDULED` after the lease expired), you now have two
workers racing to finish the same logical unit of work, and whichever
writes last silently overwrites the other's result — even if the other
one is the *current, correct* attempt.

The fix is **fencing**: every claim increments `attempt` (an integer that
only ever goes up), and every subsequent write for that claim
(`completeJob`, `failJob`, `extendLease`) is guarded by
`WHERE status = 'PROCESSING' AND locked_by = $worker AND attempt = $N`.
The moment the reaper reclaims the job, it either changes the status away
from `PROCESSING` or — if reclaimed again by a new worker — bumps
`attempt` past the zombie's value. Either way, the zombie's guarded
`UPDATE` matches zero rows and its result is silently and safely
discarded (`repository.js` returns `{ fenced: true }` in this case; the
caller logs it and moves on). This is the same idea as a fencing token in
Chubby/ZooKeeper-based distributed locks, applied directly to a row
instead of an external lock service.

## Execution idempotency: the effects ledger

Fencing prevents two *concurrent* workers from corrupting each other's
result. It does not prevent the "lost ack" scenario above, where the
*same* handler logic runs twice, sequentially, because the first run's
success was never durably recorded. For a purely-DB-writing handler this
is often naturally idempotent (an `UPDATE ... SET x = 5` run twice has the
same effect as running it once). For a handler with an external
side-effect — sending an email is the canonical example — it is not: two
runs mean two emails.

`src/jobs/effects.js`'s `once(pool, jobId, effectKey, fn)` provides a
"claim, then act" pattern: it inserts `(job_id, effect_key)` into the
`effects` table (unique-constrained on that pair) *before* calling `fn`.
A redelivered job attempting the same effect key finds the row already
there and skips `fn` entirely. This is not a full distributed
transaction — it can't be, `fn` might be an HTTP call to a third-party
API that has no notion of Postgres transactions — so there is a small
window where the process crashes exactly during `fn` and the claim
survives without the effect having actually completed; a redelivery would
then wrongly skip it. TaskFlow accepts a possible missed side effect over
a duplicate one for this class of failure, and documents it rather than
claiming a stronger guarantee than the code provides. If `fn` throws, the
claim is released so a genuine retry can attempt the effect again.

### External side effects need provider-level idempotency keys

`ctx.once()` deduplicates *within TaskFlow's own database*. It cannot make
a call to an outside system exactly-once, because the claim (a Postgres
insert) and the external call (an HTTP request to an email provider, a
payment gateway) are two separate operations that no transaction spans.
Two windows remain:

- **Crash after the claim, before/during the call** — the claim survives, a
  redelivery skips the call: the effect may be **missed**.
- **Call succeeds, worker dies before the claim/ack is recorded** (or a
  timeout makes the call *look* failed when it actually went through) — a
  retry repeats the call: the effect may be **duplicated**.

Therefore any handler that touches money, email/SMS, or other
non-reversible external state **must pass the provider a stable
idempotency key derived from the job**, for example `Idempotency-Key:
<jobId>:<effectKey>` on a Stripe charge, or the message id / dedup id on
SES/SQS. Then a repeated call is deduplicated by the provider itself, which
is the only party that can do it atomically. `ctx.jobId` is stable across
redeliveries for exactly this purpose. Rule of thumb: `ctx.once()` saves
you from *most* duplicate calls and from redoing expensive work; the
provider key is what makes the remaining window safe. The bundled
`send_email` demo handler only prints, so it uses `ctx.once()` alone; a real
one must do both.

## Three counters, three jobs: attempt, failure_count, recovery_count

`attempt` is the fencing token: it goes up on **every** claim, whatever the
reason for the claim. It cannot double as the retry budget, because claims
also happen for reasons that are not the job's fault: a worker was killed,
a node was drained during a deploy, a graceful shutdown released the job.
If `max_attempts` were compared with `attempt`, three rolling deploys could
kill a perfectly healthy job.

- `attempt` — fencing token. Never decreases (a decrease would let a
  stale worker's old token match again).
- `failure_count` — number of **handler failures**. The only thing
  `max_attempts` limits. Also drives the backoff exponent.
- `recovery_count` — number of **lease-expiry recoveries** by the reaper. It
  does not touch the retry budget, but it has its own cap
  (`MAX_LEASE_RECOVERIES`, default 10): a job that crashes every worker it
  lands on (a *poison job*: e.g. it OOMs the process) would otherwise
  crash-loop the whole fleet forever. Past the cap it goes to `DEAD` with
  reason `poison_quarantined` so a human can look at it.

Graceful-shutdown releases touch neither counter.

## The reaper must re-check expiry inside its UPDATE

The reaper first `SELECT`s jobs with `lease_expires_at < now()`, then
recovers each one. Between those two steps a live worker may heartbeat and
extend the lease. If the recovery only checked `attempt`/`locked_by` it
would still match and steal a job from a healthy worker. So
`recoverJob` repeats `lease_expires_at < now()` inside the guarded
`UPDATE ... WHERE`; the heartbeat wins the race and the recovery becomes a
no-op. The same guard makes several reapers running at once safe: only one
can win each job. (Tested in `tests/integration/retry-budget.test.js`.)

## What the worker does when the database misbehaves

Three rules, each learned from a chaos test that found the opposite:

1. A DB error while *recording* an outcome never crashes the process and is
   never reported as a handler failure. The row stays `PROCESSING`; the
   reaper recovers it after lease expiry (no retry budget spent).
2. A severed connection on a *checked-out* client must not be an uncaught
   exception (`pool.on('connect')` attaches a client error listener); the
   pool-level listener only covers idle clients.
3. If a heartbeat finds the lease gone, the handler is aborted: continuing
   would only create side effects for a run whose result is fenced off.

## Backoff with full jitter

Pure exponential backoff (`base * 2^(attempt-1)`, no randomization) means
every job that failed at the same moment retries at the same moment again
— a thundering herd, especially likely right after a real outage (e.g. a
downstream API blips and every in-flight job fails within the same
second). **Full jitter** (`random(0, cappedExponentialDelay)`, per the AWS
"Exponential Backoff And Jitter" approach) spreads retries across the
whole window instead of clustering them at the window's edges.
`src/jobs/backoff.js` takes an injectable `random` function specifically
so this is unit-testable without flaky, randomness-dependent assertions
(`tests/unit/backoff.test.js` pins `random` to fixed values to test the
cap and the monotonic growth deterministically).

## The state machine, in one place

Every `jobs.status` write lives in `src/jobs/repository.js`, and every one
of them is paired with a `job_events` row in the same transaction as the
status change. This is deliberate: with the old design, `UPDATE jobs SET
status = ...` was scattered across `api.js` and `worker.js` with no
audit trail, which made three of the bugs in `docs/AUDIT.md` (dual-write,
missing fencing, no DLQ transition) essentially invisible until you traced
through the code by hand. Centralizing the writes doesn't prevent every
bug, but it means there is exactly one place to look when auditing a
transition, and a full history (`job_events`) instead of only a single
current `status` column and a `last_error` string.

## Known simplification: FAILED is not removed from the enum

`docs/AUDIT.md`'s Section 0.1 called for mapping `FAILED → DEAD`. Postgres
cannot cheaply drop a single value from an existing `ENUM` type (it
requires rebuilding the type and every column/index/constraint that
references it). Since no production data existed when this migration ran
(confirmed with the user, who chose to start the dev database fresh — see
`docs/AUDIT.md`), the value-rebuild's risk wasn't worth it for zero
practical benefit: the migration reassigns any existing `FAILED` rows to
`DEAD` and the application code never writes `FAILED` again, but the
label itself stays in the type, unused. If this project ever needs to
support removing enum values safely (e.g. after a real production
deployment accumulates data), that would be its own migration built
around the type-rebuild pattern, done deliberately rather than as a side
effect of an unrelated feature.

## Redis today

Redis is not used for delivery. The API uses it for one `PING` in `/ready`
(reported as `degraded`, never as "not ready"); nothing else reads or writes
it. It is kept, with AOF on, as the planned home for a wake-up signal,
rate-limit counters, and the `QueueDriver` seam for Kafka. Until one of those
exists it is an honest cost with no benefit; removing it from compose is a
valid simplification (see docs/AUDIT.md, "Remaining").

## What's not built yet (see docs/PROGRESS.md and manual_work.md)

Priority *starvation protection* (weighted polling or aging) is not
implemented: ordering is strict priority, so sustained HIGH load can starve
LOW. The API does not yet expose `priority`/`delayMs`/`runAt`. DLQ
redrive/purge, list/cancel endpoints, the dashboard UI, `/metrics`,
Grafana, tracing, and load tests are not built. The full, prioritised list
with acceptance criteria is the top section of `manual_work.md`.
