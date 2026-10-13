# AI runtime guide

Run `npm ci`, then `npm start`. Open `/agents` on the same local server and connect with your workspace token. Original Boolean/multivariate flags remain available at `/`.

## First workflow

1. Create an evaluation judge (`contains`, `exact`, or `llm`). LLM judges need provider/model and a rubric requesting JSON `{ "score": 0.0, "reason": "..." }`; high scores must mean better quality.
2. Create an evaluation dataset with unique row IDs, input, expected output, and optional prompt variables.
3. Create a completion or agent config with variation IDs, provider/model, weights totaling 100, prompts/instructions, and optional judge/targeting/policies. The UI offers starters.
4. Resolve it in the runtime playground. This previews config, without invoking a provider.
5. Integrate `RuntimeClient` in your app to invoke a provider, score outputs, and record telemetry; or use the dashboard's provider-backed playground once server credentials are configured.
6. Inspect history, version-level metrics, trends, and alerts. Restore creates a new immutable version and clears rollout/experiment policies.

Disabled configs serve their explicit default variation. They do not stop your application from calling a model. Choose a safe baseline and implement an app-level stop if no generation is desired.

## Provider configuration

Provider credentials live in server/application environment variables, never in resource JSON or browser storage:

| Provider | Environment configuration |
|---|---|
| OpenAI | OPENAI_API_KEY |
| Anthropic | ANTHROPIC_API_KEY |
| Gemini | GEMINI_API_KEY |
| Bedrock | ENABLE_BEDROCK=true, AWS_REGION; AWS SDK credential chain (IAM role/profile/env) |

Restart the server after setting environment variables. The runtime page reports configured providers without exposing credentials. Supply actual model IDs approved for your account; starter model names are placeholders. Native adapters implement bounded text completions and accept `temperature`, `top_p`, `max_tokens`/`max_output_tokens` (1–4096). Some models reject unsupported parameters; configure only supported settings. Provider costs remain unknown unless a variation supplies validated `pricing: {inputPerMillion, outputPerMillion}` rates. These are estimates from configured rates, not reconciled invoices.

Release 0.5 supports bounded native streaming, image inputs and tool/agent loops for compatible OpenAI, Anthropic, Gemini and Bedrock models. Tools require explicitly registered handlers and any required approval. Missing usage is unknown rather than zero. See OPERATIONS_GUIDE.md for evaluation and provider workflows and SELF_HOSTED_DEPLOYMENT.md for deployment.

## SDK integration

```javascript
import { RuntimeClient } from './src/runtime-sdk.js';
import { providersFromEnvironment } from './src/providers.js';

const client = new RuntimeClient({
  baseUrl: 'http://127.0.0.1:4315',
  token: process.env.FLAG_ADMIN_TOKEN,
  environment: 'development',
  providers: providersFromEnvironment()
});
const result = await client.execute('support-agent', {
  context: {userId: 'stable-id', attributes: {tier: 'enterprise'}},
  variables: {topic: 'billing'},
  input: 'How do I update my billing details?',
  expected: 'billing' // required only for deterministic expected-text judges
});
console.log(result.output, result.attempts);
```

Each attempt has a trace ID, version, variation, metrics, judgement, and telemetry result/error. Missing provider or config access fails explicitly. SDK timeouts abort provider signals; an app executor must honor cancellation to stop underlying work. If telemetry fails, inspect `telemetryError`; a fallback attempt is not issued without successfully recording the first outcome.

`client.benchmark({config, dataset, judge})` pins all three resource versions, generates every row/variation, and submits aggregate/row scores. `client.runGraph(key, {context, variables, input, executor, selectEdge})` traverses a configured graph with a step cap; graph structure and initial node config decisions are pinned. Changing an enabled config does not alter an in-flight graph snapshot, but stopping it blocks further node visits.

For LangChain models, use `langChainExecutor({buildRunnable})` from `src/frameworks.js`; the builder creates a model with the resolved provider/model/prompts/parameters. For LangGraph, use `langGraphExecutor({graph})`; its model node reads `configurable.runtimeConfiguration`. Framework installation, credentials, tools and approval behavior remain application-owned.

## Rules and policies

- Targeting rules evaluate in order; first match serves its variation. Operators: eq, in, gte, lte, contains. Untargeted contexts use weighted allocation.
- A/B allocation is deterministic and analysis uses conservative time-uniform bounded intervals over independent subjects. Bandits use epsilon-greedy allocation from reported reward (0–1), with assignments pinned per subject/config version; bandit reports do not establish a fixed-randomization winner.
- Guard windows operate on completed outcomes from the current config version. Quality/cost/latency thresholds require minimum measured samples. Missing metrics are not zero. Guard actions pause or restore a known earlier version.
- Progressive rollouts use increasing percentages ending at 100; a stage advances only after elapsed time and completed candidate samples. Advancement is event-driven when new outcomes arrive. No traffic means no advancement.
- Adaptive triggers support delay, cooldown and repeatable window/threshold policies. Switching clears competing rules/policies and records an alert. Slack deliveries require explicit channel opt-in; new channels skip pre-existing alerts.
- Experiments cannot coexist with progressive rollouts, guards or adaptive triggers on the same config.
- A retry policy allows one fallback for a failed or low-quality first attempt, linked by parent trace ID. It cannot repeat indefinitely; current config changes block stale retries.
- Signed configuration exports expire after 60 seconds. `verifiedSnapshot()` requires an independently pinned public key. The signing key persists with the database. The Node client supports short-lived verified cached fallback for safe baseline configurations; cached data cannot receive live revocations or execute online automation.

## Roles and approvals

The default server starts one local owner. To provision more local identities, set `FLAG_CREDENTIALS_JSON` to a JSON array of `{token,tenant,actor,role}` entries in your environment. Keep this outside source control. Roles: owner/admin/operator/reviewer/read-only. Operator cannot edit production; reviewer can decide change requests. Configure `REQUIRE_PRODUCTION_APPROVAL=true` to route production saves/restores into requests. A different actor must approve; stale requests cannot overwrite newer changes. Emergency stops and previously configured automated safeguards remain immediate and audited.

Operations adds managed accounts, scoped credentials, encrypted provider secrets, OIDC sign-in, MFA and recovery codes. See the operations guide for setup and deployment limits.

## API additions

Under `/api/runtime`, with the same workspace token and `environment` query parameter:

- GET/PUT `{configs,datasets,judges,graphs,models,tools}` and `/:key`; GET `/:key/history`; POST `/:key/restore`.
- POST `configs/:key/resolve`, `configs/:key/preview`, `configs/:key/retry`, `configs/:key/stop`; GET `configs/:key/metrics`.
- POST `graphs/:key/resolve` and `graphs/:key/visit`; GET `graphs/:key/metrics`.
- POST `outcomes`; GET `overview`, `insights` (optional from/to/key), `providers`, `snapshot`.
- POST `benchmarks` to score app-generated outputs; POST `benchmarks/run` to generate and score up to 100 provider calls.
- GET/POST `playground`; provider-backed POST requires `allowProviderCalls:true`.
- GET `approvals`; POST `approvals/:id` with `decision: approve` or `reject`.

Resource writes require expectedVersion, 0 for new resources. Provider-backed calls require an operator/admin/owner and explicit per-run authorization. They can incur charges. Use the Operations guide for job cancellation, trace ingestion and provider credential management.

## Release 0.3.0

Use `/operations` for provider credentials, evaluation jobs, experiment analysis, traces, schedules, accounts, MFA, notifications and retention. Account sign-in persists across pages in a one-hour HttpOnly cookie; manual API keys remain in page memory. Set `PUBLIC_ORIGIN` to the exact HTTPS origin for a reverse proxy.

See [operations guide](OPERATIONS_GUIDE.md) and [self-hosted deployment guide](SELF_HOSTED_DEPLOYMENT.md).

