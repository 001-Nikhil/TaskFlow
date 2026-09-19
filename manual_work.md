# manual_work.md — Things ONLY YOU Can Do

This file lists ONLY the things Claude cannot do for you: your accounts, secrets, money, decisions, real-world observation, and your own understanding.

**Not in this file:** installing tools/packages/dependencies (Node packages, k6, psql, redis-cli, Docker images, CLI tools, etc.). Claude installs those itself when it can, or asks you first when it needs your permission, a password, or a GUI installer. See "Installation Policy" in CLAUDE.md.

Tick items as you finish them. Claude adds new items at the bottom whenever it hits a blocker.

Legend: 🔴 blocks Claude's work · 🟡 needed soon · 🟢 later / optional

---

## A. Machine-Level Things Claude Can't Do From a Terminal 🔴

Claude handles normal installs itself (see CLAUDE.md). It will stop and add an item here only if one of these is needed:

- [ ] **Docker Desktop / Node.js / Git first-time installation** if they are missing and need a GUI installer, admin approval, or a reboot. Claude will tell you exactly which one and give the download link.
- [ ] **Docker resource limits** (Docker Desktop -> Settings -> Resources): give it at least 4 GB RAM and 2 CPUs so Postgres, Redis, several workers and Grafana run comfortably. This is a GUI setting.
- [ ] **Enable virtualization / WSL2** (Windows) or approve system prompts (macOS/Linux) if Docker fails to start because of them.
- [ ] **Type your `sudo` / admin password** when Claude asks. Claude never stores or guesses it.
- [ ] Git identity, if unset: `git config --global user.name "..."` and `git config --global user.email "..."`

---

## B. Secrets & Environment 🔴

Claude creates `.env.example`. You create the real `.env` (never commit it).

- [ ] Copy: `cp .env.example .env`
- [ ] Set strong values yourself (don't reuse passwords): `POSTGRES_PASSWORD`, `API_KEY`, `REDIS_PASSWORD` (if enabled), `GRAFANA_ADMIN_PASSWORD`.
  - Generate a key: `openssl rand -hex 32`
- [ ] Confirm `.env` is in `.gitignore`: `git check-ignore .env` should print `.env`
- [ ] If any secret was ever committed by accident: **rotate it** (changing the file is not enough — it stays in git history).

---

## C. Verify Things By Actually Watching Them 🟡

Claude can write and run automated tests, but *you* must see these behaviors with your own eyes at least once. This is where the learning (and interview story) comes from.

- [ ] **Crash recovery demo.** Start 3 workers, submit ~50 jobs (with a slow handler), then hard-kill one mid-job:
  ```
  docker compose up -d --scale worker=3
  docker ps                 # find a worker container
  docker kill <worker>      # SIGKILL: no graceful shutdown
  ```
  Watch the dashboard / `psql`: the job should wait for lease expiry, get retried by another worker, and finish **once**. Note how long recovery took.
- [ ] **Graceful shutdown demo.** `docker compose stop worker` (SIGTERM) during a job → confirm the job completes and the worker exits cleanly (no retry).
- [ ] **Lost-ack demo.** Use the debug flag/script Claude provides to drop the ack after success; confirm the side-effect table has exactly **one** row for that job.
- [ ] **Redis wipe demo.** `docker compose exec redis redis-cli FLUSHALL` while jobs are pending → confirm the reconciler restores them. (Only do this on your local dev stack.)
- [ ] **Look at the query plans yourself.** Run `EXPLAIN (ANALYZE, BUFFERS)` on the claim query and the dashboard queries with ~1M rows seeded (Claude provides a seed script). Confirm indexes are used.
- [ ] Eyeball the dashboard and Grafana: do the numbers make sense against what you submitted?

---

## D. Load Testing 🟡

- [ ] Run k6 scripts on your own machine (results depend on your hardware, so Claude can't produce real numbers):
  ```
  k6 run tests/load/submit.js
  ```
- [ ] Paste the real output into `docs/PERFORMANCE.md` along with your machine specs (CPU, RAM, Docker limits). Never use numbers you didn't measure.
- [ ] Try scaling workers (1 → 3 → 6) and note throughput change and where the bottleneck moves (CPU, PG connections, Redis, API).

---

## E. Source Control & Repo Settings 🟡

- [ ] Create the GitHub repo (private at first, public when ready).
- [ ] Push the project: `git remote add origin <url> && git push -u origin main`
- [ ] Enable branch protection on `main` (require PR + passing CI) if you want to practice a real workflow.
- [ ] Add CI secrets in GitHub → Settings → Secrets and variables → Actions (only if CI needs any).
- [ ] Enable Dependabot / secret scanning (Settings → Code security).

---

## F. Observability Setup Checks 🟡

- [ ] Open Grafana (default `http://localhost:3001`, or whatever compose maps) and log in with the password you set.
- [ ] Confirm the Prometheus data source is green (Connections → Data sources → Test).
- [ ] Confirm the provisioned TaskFlow dashboard shows live data while jobs run.
- [ ] (If using OpenTelemetry with a UI like Jaeger/Tempo) open it and verify one job's trace spans API → queue → worker.

---

## G. Kafka Phase 🟢 (only when you decide to do it)

- [ ] **Decide** whether Kafka replaces or sits beside Redis (Claude will present tradeoffs in an ADR — you make the call).
- [ ] Give Docker enough memory (Kafka is heavy) or choose a lightweight local option (Redpanda) — your decision.
- [ ] Understand and accept the priority limitation (Kafka has no native priorities → separate topics).
- [ ] For cloud Kafka (AWS MSK) see section H — it costs real money.

---

## H. AWS / Cloud Deployment 🟢

Claude can write Terraform/CloudFormation/compose-prod files and docs, but **you** must do everything that touches your account or billing.

- [ ] Create an AWS account (or use an existing one). Enable **MFA on the root user**.
- [ ] **Set a billing alarm / budget first** (Billing → Budgets → e.g. $10 alert). Do this BEFORE creating anything.
- [ ] Create an IAM user/role with least privilege for deployment (do not use root keys). Run `aws configure` locally.
- [ ] Choose region and confirm which services you'll use (e.g. ECS/Fargate or EC2, RDS Postgres, ElastiCache Redis, ALB, CloudWatch). Each costs money — check pricing and free-tier limits.
- [ ] Run the provisioning yourself after **reading** the plan Claude prepared (`terraform plan` → review → `terraform apply`).
- [ ] Store production secrets in AWS Secrets Manager / SSM Parameter Store (not in the repo).
- [ ] Configure RDS backups and confirm you can restore one.
- [ ] Security groups: DB and Redis must NOT be open to `0.0.0.0/0`.
- [ ] Register a domain / TLS certificate (ACM) if you want a public URL.
- [ ] **Tear down** cloud resources when you're not using them (`terraform destroy`) and re-check the billing dashboard the next day.

---

## I. Your Own Understanding & Portfolio 🟡

These can't be delegated; the point of the project is that *you* can explain it.

- [ ] For each concept in `docs/DESIGN.md` (at-least-once, idempotency, visibility timeout/lease, fencing token, backoff+jitter, backpressure, SKIP LOCKED, outbox pattern), **explain it out loud or in writing without looking**. If you can't, ask Claude to teach it with a smaller example.
- [ ] Read the core code paths line by line (claim → execute → complete → reaper) and be able to draw them.
- [ ] Write the README intro and the "problem I solved / what I learned / tradeoffs" section **in your own words**.
- [ ] Record a 2–3 min demo (screen recording) of the crash-recovery scenario.
- [ ] Prepare the interview one-liner: *"My worker can crash mid-job and the system recovers without losing or double-processing it — here's how and how I tested it."*
- [ ] Add the project to your resume/LinkedIn with real, measured numbers only.

---

## J. Decisions Only You Can Make 🟡

Claude will recommend, but you decide:

- [ ] TypeScript vs staying in JavaScript.
- [ ] Vitest vs Jest (if not already chosen).
- [ ] Priority policy: weighted fair (e.g. 6:3:1) vs aging.
- [ ] Default retry policy (max attempts, base delay, cap).
- [ ] Retention period for completed jobs / events.
- [ ] Redis-primary queue vs Postgres-primary claiming with Redis as notifier.
- [ ] Whether/when to do the Go worker and the Kafka migration.

---

## K. Ongoing Hygiene 🟢

- [ ] Periodically `npm audit` and update dependencies (review changelogs first).
- [ ] Rotate API keys/passwords if they are ever exposed.
- [ ] Back up your local Postgres volume before any risky experiment: `docker compose exec postgres pg_dump -U <user> <db> > backup.sql`
- [ ] Review `docs/AUDIT.md` "Known issues" monthly.

---

## Claude-Added Items

_(Claude appends new manual tasks below with date, why it's manual, exact steps, and what it will do after you finish.)_
