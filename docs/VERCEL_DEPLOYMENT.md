# Hosted deployment

Vercel runs `api/index.js` with Node 24. Durable application records live in Neon
PostgreSQL. The local `npm start` and Docker deployments continue to use SQLite.
The hosted database is a separate workspace; local credentials and provider keys
are not copied into it automatically.

Set `DATABASE_URL`, `FLAG_ADMIN_TOKEN`, `RUNTIME_VAULT_KEY`, `CRON_SECRET`,
`QSTASH_CURRENT_SIGNING_KEY` and `QSTASH_NEXT_SIGNING_KEY` as sensitive server
environment variables. Keep the vault key unchanged across releases; changing it
makes previously encrypted provider credentials unreadable. Configure the exact
production URL in `PUBLIC_ORIGIN` when using a custom domain.

The repository compatibility layer executes PostgreSQL queries through a dedicated
Node worker and preserves synchronous domain transactions. TLS certificates are
verified. Writes that require a transaction acquire a PostgreSQL advisory lock,
including initial schema creation. Database calls are serialized per function
instance; this is suitable for modest workloads, not high-throughput traffic.
Query timeout is 20 seconds and response size is capped at 16 MiB.

## Background work

Create a QStash schedule for `POST https://YOUR_PROJECT.vercel.app/api/worker`,
with an empty body and cron `*/5 * * * *`. The handler validates QStash's signed
JWT, destination, expiry and body hash. No workspace credential is sent to QStash.
Five-minute scheduling consumes 288 deliveries per day before retries, within
the selected free plan's 500-message daily allowance. Set retries to zero for
this recurring poll; the next scheduled request resumes interrupted work.
The daily Vercel cron is a backup, authenticated with `CRON_SECRET`.

Authenticated app traffic also wakes work at most every five seconds per
instance. Workers acquire a shared six-minute lease and checkpoint one dataset
row per run. If an invocation is interrupted, a later worker resumes saved
progress after the lease expires. Evaluations need explicitly authorized provider
calls and a configured provider key. When the app is idle, schedules, release
checks and webhook deliveries can run up to five minutes after their due time.
The free hosting and scheduler quotas limit throughput; this is not an unlimited
enterprise deployment.

## Verification and operations

Run `npm test`, `npm run check`, `node scripts/secret-check.mjs` and `npm audit`.
For an isolated hosted integration fixture, set `DATABASE_URL` locally and run
`node scripts/postgres-check.mjs`. It uses a disposable verification tenant,
removes its records afterwards, and makes no paid provider requests. The test
checks flag changes, runtime resources, resumable evaluations, SCIM filtering,
credential revocation, immutable history, tenancy and two-instance conflicts.

`/guide` serves the interactive guide and `/guide.pdf` serves its landscape PDF.
`/health` is public; application API endpoints require workspace authentication.
For backups, use Neon's database export/recovery facilities; the local SQLite
backup script applies only to the local/Docker installation.
