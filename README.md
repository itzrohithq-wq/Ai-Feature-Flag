# Control Studio - AI Feature Flag System

Self-hosted feature flags and AI runtime controls for prompts, models, evaluations and guarded releases. Version 0.6.0.

## Live application

- [Open Control Studio on Vercel](https://ai-feature-flag.vercel.app/)
- [Open Feature Flags](https://ai-feature-flag.vercel.app/flags)
- [Open AI Runtime](https://ai-feature-flag.vercel.app/agents)
- [Open Workspace](https://ai-feature-flag.vercel.app/operations)
- [Read the PDF user guide](output/pdf/Control-Studio-Designed-User-Guide.pdf)
- [Open the hosted PDF guide](https://ai-feature-flag.vercel.app/guide.pdf)

The hosted workspace requires its own credentials; local workspace tokens do not grant access to it.

## Start locally

Requires Node.js 24.14 or newer within the 24.x release line.

```sh
git clone https://github.com/itzrohithq-wq/Ai-Feature-Flag.git
cd Ai-Feature-Flag
npm ci
npm start
```

For local development, the server listens at `http://127.0.0.1:4315`. It prints a local owner token; paste it into Connect workspace on your local installation. Set FLAG_ADMIN_TOKEN in the server environment for a persistent token. New installations generate a fresh token on restart otherwise. Local state is stored in data/flags.sqlite and is excluded from Git. To use the deployed application, [open Control Studio on Vercel](https://ai-feature-flag.vercel.app/).

Use [Feature Flags](https://ai-feature-flag.vercel.app/flags) for boolean/multivariate flags, [AI Runtime](https://ai-feature-flag.vercel.app/agents) for configurations and the playground, and [Workspace](https://ai-feature-flag.vercel.app/operations) for evaluation jobs, monitoring, releases and access settings. The [product website](https://ai-feature-flag.vercel.app/) opens first at the Vercel URL.

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
- [Open the interactive user guide](https://ai-feature-flag.vercel.app/guide)
- [Interactive HTML guide source](output/pdf/Control-Studio-Interactive-Guide.html)
- [Runtime and SDK guide](docs/RUNTIME_GUIDE.md)
- [Operations guide](docs/OPERATIONS_GUIDE.md)
- [Self-hosted deployment and recovery](docs/SELF_HOSTED_DEPLOYMENT.md)

The guides use synthetic examples and contain no usable credentials. The PDF and hosted interactive guide link to the deployed Vercel application. The downloadable HTML source retains local-development links.

## Verification

```sh
npm test
npm run check
npm audit
```

Optional browser checks require Playwright and @axe-core/playwright in a separate verification installation. Set PLAYWRIGHT_MODULE_ROOT to that installation and BROWSER_CHANNEL to chrome, then run npm run test:browser, npm run test:operations and npm run test:completion. The checks use isolated test stores and no paid provider calls. Other scripts cover SDK, container, collector and deployment checks.

[Final security check](docs/SECURITY_CHECK.md) records the checks completed before publication. See [security guidance](SECURITY.md) for credentials and production configuration.

## Deployment boundary

The Vercel deployment uses durable PostgreSQL storage and a signed background worker; see the [hosted deployment guide](docs/VERCEL_DEPLOYMENT.md). For self-hosting, use the supplied compose.production.yaml and configure your own domain, HTTPS origin and persistent owner token; local and Docker installations use SQLite. These deployments do not establish enterprise availability guarantees or full competitor equivalence. Real provider, OIDC, SCIM and Slack integrations require your own accounts and configuration.

## Third-party assets

Manrope and Lucide notices are included under public/. Pogonia was supplied by the project owner without a separate distribution license; its provenance is recorded in public/FONT-SOURCES.txt. Verify distribution rights before reusing that font in another product.
