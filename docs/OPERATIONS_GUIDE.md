# Operations guide

Open `/operations` and connect with the existing workspace token. Account sign-in uses an expiring HttpOnly, SameSite cookie across product pages, with same-origin checks on browser writes. Manual API tokens remain in page memory. Set PUBLIC_ORIGIN to the exact public HTTPS origin behind a reverse proxy.

## Providers and live verification

An administrator can save an OpenAI, Anthropic or Gemini key in Provider credentials. Values are encrypted with AES-256-GCM, never returned by the API, and scoped to the workspace. Environment-provided adapters remain supported, including AWS Bedrock through the AWS credential chain. Deleting a stored credential falls back to a configured environment adapter if one exists.

The launcher automatically loads a local `.env` file if present. The `.env` and `data` paths are ignored by Git. `RUNTIME_VAULT_KEY` may specify a 64-character hex key; otherwise the launcher creates `data/vault.key`. Preserve that key separately from database backups and protect access to both. Production operators should supply the encryption key through their secret-management service.

To run the requested small OpenAI smoke test after storing a key:

```powershell
$env:ALLOW_LIVE_PROVIDER_TEST='true'
$env:OPENAI_TEST_MODEL='gpt-4.1-mini'
node scripts/live-openai-check.mjs
```

The test sends only synthetic arithmetic input, requests a short completion and LLM judge score, and saves a report under `data/verification`. Provider calls can incur charges. The Responses adapter uses `store:false`. [OpenAI model documentation](https://developers.openai.com/api/docs/models/gpt-4.1-mini).

## Evaluations and experiments

Queue an evaluation with a config, dataset and judge. The job pins all three versions and checkpoints each completed row/variation pair. Cancel stops further work after an in-flight provider request finishes; resume retains completed rows. Restart recovery resumes unfinished jobs. A crash between receiving a provider result and saving its checkpoint may repeat that request; execution is not exactly once.

Datasets support up to 1000 rows within 4 MB, and jobs up to 1000 row/variation pairs. Optional row `tags` produce saved slice summaries. Configs can attach up to five `judges`; online outcomes retain each judge's pinned version and score. Every judge must define higher scores as better quality. LLM judges require provider credentials and a rubric.

Experiment analysis supports quality, reward, satisfaction and error rate. It uses one observation per subject, bounded time-uniform Hoeffding intervals with alpha spending, conservative allocation checks, minimum samples and optional stable holdouts. Targeted, held-out, explicit preview and retry traffic is excluded. Bandits report observations but do not receive fixed-randomization winner claims. The sample planner estimates conservative fixed-time precision; it does not guarantee power or a sequential stopping time. These methods are not described as LaunchDarkly's proprietary algorithm.

For example:

```json
{"experiment":{"mode":"ab","metric":"reward","baseline":"baseline","alpha":0.05,"minSamples":30,"holdoutPercent":10}}
```

A guard may additionally specify `statistical` with `baseline`, `candidate`, `metric`, `alpha` and `tolerance`. `maxWaitSeconds` applies the configured pause/rollback action when the sample requirement is not met by the deadline. Existing absolute thresholds remain supported. Adaptive triggers support `delaySeconds`, `cooldownSeconds`, and `repeat:true`; a fully switched configuration does not repeatedly switch itself.

## Graphs and audiences

The runtime library includes audience segments, attribute targeting and a visual graph editor. Segments support explicit inclusions/exclusions and OR-matched attribute rules; exclusions take precedence. Config versions pin their segment definitions. Save a new config version to adopt an updated segment.

Graph nodes reference agent-mode configs. The visual editor changes nodes, root, connections and maximum steps; existing JSON editing remains available. Backend validation rejects orphan nodes and invalid references. Actual models, application tools and handoff decisions remain app-owned.

## Access and security

Administrators can create expiring, revocable API credentials with environment and resource scopes. Resource scopes use paths such as `configs/support`, or `*` for workspace-wide access. Narrowly scoped service credentials can retrieve/resolve their resources and submit linked outcomes, but cannot inspect broad workspace dashboards or exports.

Team accounts use salted scrypt password hashes and one-hour sessions. Accounts support password changes, disabling, TOTP authentication, replay checks and single-use recovery codes. Enabling MFA or changing a password revokes existing actor credentials. Save recovery codes when they are shown. API tokens are separate from interactive MFA; the original owner token is a bootstrap credential and should be protected accordingly.

Optional SSO uses OpenID Connect authorization code flow, PKCE, nonce/state checks and ID-token signature verification through `openid-client`. Configure `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` and `OIDC_REDIRECT_URI`. Provision each exact OIDC subject in Team accounts; there is no automatic privileged account creation. Use HTTPS for deployed sign-in. A real identity-provider connection remains necessary to validate organization-specific policies.

## Monitoring, notifications and releases

`POST /api/runtime/traces` accepts OTLP JSON resource/scope spans or a `spans` array. Trace IDs are 32 hex characters, span IDs 16, and timestamps Unix nanoseconds. Up to 200 spans are accepted per batch. The endpoint is JSON-only, not an OTLP protobuf/gRPC collector.

A span attribute `runtime.execution_id` can link to an existing scoped execution. Status code 2 records failure; duration and supported usage/quality/cost attributes can produce an outcome and trigger its safeguards. Duplicate outcomes remain idempotent. Invalid or foreign execution links return warnings without revealing another workspace's data. Prompts and outputs are not automatically collected by the Node client's optional `traceEnabled:true` mode.

Release alerts appear in the notification inbox. An administrator may explicitly configure an encrypted Slack incoming webhook and opt into outbound delivery. The outbox records delivery state, retries failures with backoff and stops after five attempts. Fixture testing does not establish delivery to a real Slack organization.

Scheduled development/staging changes execute at the selected time. Production schedules require a different reviewer. Execution rechecks the expected config version; stale changes fail instead of overwriting newer work. Pending schedules can be cancelled.

Monitoring evidence can be downloaded as JSON. Retention provides a preview and an explicit cleanup action for old spans and finished jobs; configuration and audit history are retained.

## Distribution and SDKs

Node `RuntimeClient.watch(key,{signal})` streams changed config versions over authenticated SSE, checked every 500 ms. Managed credential expiry/revocation closes the stream. This polling interval is not an end-to-end latency guarantee.

With independently pinned `trustedPublicKey` and expected `tenant`, `cacheSnapshot()` and `resolveWithFallback()` provide an explicit, short-lived signed cache. Cached decisions expire after 60 seconds, do not mask authorization errors, and use the default variation for automated/experimental configs. Offline decisions have no live trace ID and do not run online evaluation or automation. Revocation cannot instantly invalidate a disconnected copy.

The dependency-free Python client is in `sdk/python/control_studio.py`. Node framework helpers are tested against actual LangChain/LangGraph packages; integrating applications still supply their models, tool permissions and execution functions.

## Deployment and recovery

```powershell
docker compose up --build -d
node scripts/backup.mjs NEW_BACKUP_PATH
```

Compose binds the app to localhost, keeps data in a named volume and enables production approvals. The container runs as a non-root user. Deploy behind HTTPS and restrict network access appropriately. The default architecture uses one server process. `npm run start:cluster` runs 2–8 API processes on one host with the same local SQLite WAL database and an elected background worker. SSO and sessions share database state. An abrupt leader crash can require up to 60 seconds for the lease to expire. This does not support SQLite over a network filesystem or provide multi-region database HA.

The backup command uses SQLite's online backup mechanism and checks integrity, refusing to overwrite an existing file. To restore, stop the server, preserve the current database, place the verified backup at a new `FLAG_DB_PATH`, and retain the matching vault key. Backup/restore tests used isolated fixtures.

Verification commands: `npm test`, `npm run check`, the two browser scripts, `node scripts/load-check.mjs`, and `node scripts/container-check.mjs`. Browser scripts require the configured external Playwright runtime. The Python check additionally requires `PYTHON_EXECUTABLE`. There is no separate ESLint configuration or frontend compilation step in this vanilla application.

## Release 0.4 workflows

Operations now has Evaluations, Observability, Releases, and Access & settings tabs. Release plans snapshot a source config and its model/tool/judge/segment dependencies, promote libraries atomically with staging, and include the complete bundle in independent production review. Each deployed stage requires scored execution evidence before progression. Changed deployed versions require a new plan.

Judge calibration accepts 3–100 examples with input, output, expected and humanScore from 0 to 1. It records mean absolute error and agreement within 0.2 against a pinned judge version. It measures these examples rather than certifying general judge quality. LLM calibration requires explicit provider-charge authorization.

Business-metric imports accept up to 500 existing execution events. Per-row results show accepted, duplicate and rejected records; an import can succeed partially.

The OpenAI playground streams Responses API text, accepts up to three PNG/JPEG/WebP images of 500 KB each, and can execute registered server tools. Agent instruction mode and tool-enabled durable evaluation jobs are supported. Only the calculator handler is bundled. Add application handlers through createApp toolHandlers; a stored tool schema never becomes executable code. Tool approval applies to the explicitly named tools for that opted-in run. Calls are bounded to six model turns and ten tool invocations, with a generation timeout. Usage sums model turns; separate judge charges are not included in generation cost. Other native providers currently offer text generation.

Go and Java sources are under sdk/go and sdk/java. Java requires JDK 17+ and uses application-owned JSON serialization; Go requires 1.23+. Python offers retries, graph traversal, watching, signature verification and a safe-default outage fallback. Python signature verification needs the optional cryptography package; ordinary requests use the standard library. Node supports bounded graph handoff input/state callbacks. Clients do not all expose the same high-level APIs.

Choose one Compose deployment: docker compose up --build -d for a single process, or docker compose -f compose.cluster.yaml up --build -d for a same-host cluster. Do not start both against the same listening port. Configure a persistent owner credential and exact PUBLIC_ORIGIN for an HTTPS proxy.
