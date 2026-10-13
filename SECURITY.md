# Security

Do not publish workspace tokens, provider keys, account passwords, MFA recovery codes, databases, vault keys or recovery snapshots. The repository excludes local data and environment files. Use environment variables or the encrypted provider-credential controls for secrets.

Use a scoped credential for application integrations. Keep the owner credential on the server. For production, set a persistent random owner token, configure the exact HTTPS PUBLIC_ORIGIN, enable production approvals and use the supplied reverse proxy. Local development binds to loopback by default.

The self-hosted deployment uses local SQLite on one host. Protect backups together with their vault keys and do not expose the app port directly to the internet. See docs/SELF_HOSTED_DEPLOYMENT.md.

If a credential is exposed, revoke or rotate it at its issuer. Removing it from a file does not revoke it. Report suspected vulnerabilities privately through GitHub Security Advisories when available; do not include secrets in public issues.

The release checks are regression and dependency checks, not a penetration-test certification. Live external identity/provider configurations and production infrastructure require verification in their target environment.
