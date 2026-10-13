# Control Studio - AI Feature Flag System

Self-hosted feature flags and AI runtime controls for prompts, models, evaluations and guarded releases. Version 0.6.0.

## Start locally

Requires Node.js 24.14 or newer within the 24.x release line.

```sh
git clone https://github.com/itzrohithq-wq/Ai-Feature-Flag.git
cd Ai-Feature-Flag
npm ci
npm start
```

Open http://127.0.0.1:4315. The server prints a local owner token; paste it into Connect workspace. Set FLAG_ADMIN_TOKEN in the server environment for a persistent token. New installations generate a fresh token on restart otherwise. Local state is stored in data/flags.sqlite and is excluded from Git.

Use Feature flags for boolean/multivariate flags, AI runtime for configurations and the playground, and Workspace for evaluation jobs, monitoring, releases and access settings. The product website is at /welcome.

## Features

- Versioned flags and AI configurations, targeting, prompt snippets and model profiles.
- OpenAI, Anthropic, Gemini and optional Amazon Bedrock execution; provider capabilities differ.
- Playground, streaming, image inputs, registered tools and bounded agent graphs.
- Judges, datasets, calibration, evaluation jobs and online outcomes.
- Experiments, sample planning, progressive rollouts, guards, rollback and retries.
- Monitoring, trace ingestion, metric imports, audit, notifications and retention.
- Scoped credentials, accounts, MFA, OIDC, SCIM provisioning and workspace policies.
- Node, Python, Go and Java SDKs; release approvals, Docker deployment and recovery tools.

Real AI requests require provider credentials and can incur provider charges. Select an actual model supported by your provider account. Resolve checks configuration selection; Generate calls the model. A stopped configuration serves its default variation.

## User guide

- [Landscape PDF guide](output/pdf/Control-Studio-Designed-User-Guide.pdf)
- [Interactive HTML guide](output/pdf/Control-Studio-Interactive-Guide.html) - download and open locally for hover animations; GitHub displays HTML source.
- [Runtime and SDK guide](docs/RUNTIME_GUIDE.md)
- [Operations guide](docs/OPERATIONS_GUIDE.md)
- [Self-hosted deployment and recovery](docs/SELF_HOSTED_DEPLOYMENT.md)

The guides use synthetic examples and contain no usable credentials. Links into the application require the local server to be running.

## Verification

```sh
npm test
npm run check
npm audit
```

Optional browser checks require Playwright and @axe-core/playwright in a separate verification installation. Set PLAYWRIGHT_MODULE_ROOT to that installation and BROWSER_CHANNEL to chrome, then run npm run test:browser, npm run test:operations and npm run test:completion. The checks use isolated test stores and no paid provider calls. Other scripts cover SDK, container, collector and deployment checks.

[Final security check](docs/SECURITY_CHECK.md) records the checks completed before publication. See [security guidance](SECURITY.md) for credentials and production configuration.

## Deployment boundary

Use the supplied compose.production.yaml and configure your own domain, HTTPS origin and persistent owner token. This is a self-hosted application on one host with SQLite; it does not establish enterprise availability guarantees or full competitor equivalence. Real provider, OIDC, SCIM and Slack integrations require your own accounts and configuration.

## Third-party assets

Manrope and Lucide notices are included under public/. Pogonia was supplied by the project owner without a separate distribution license; its provenance is recorded in public/FONT-SOURCES.txt. Verify distribution rights before reusing that font in another product.
