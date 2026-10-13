# Self-hosted deployment — 0.6

## Start locally

Set STUDIO_ADMIN_TOKEN to a persistent randomly generated owner token using your shell environment or an untracked local .env file. Do not put real secrets in source control. Run:

    docker compose -f compose.production.yaml up -d --build

Open http://localhost:8080. The application volume persists accounts, configurations, policies, encrypted credentials and its vault key. The existing development app on port 4315 is separate; this deployment starts with its own persistent volume. Do not migrate a workspace by running two writable copies of its database.

## Publish on your own server

Copy the product onto the server, configure STUDIO_ADMIN_TOKEN, and set:

    STUDIO_SITE=studio.your-domain.example
    STUDIO_PUBLIC_ORIGIN=https://studio.your-domain.example
    STUDIO_BIND_ADDRESS=0.0.0.0
    STUDIO_HTTP_PORT=80
    STUDIO_HTTPS_PORT=443

Replace the example domain with a domain you control, point DNS at the server, and make ports 80/443 reachable. Configure organization OIDC and provider credentials separately. Caddy automatic HTTPS needs a reachable domain; local proxy checks do not certify public TLS. See [Caddy HTTPS documentation](https://caddyserver.com/docs/quick-starts/https).

Keep PUBLIC_ORIGIN equal to the externally visited origin so login cookies and mutation-origin checks work through the proxy. The application has no direct host-published port in this configuration. See [Docker service configuration](https://docs.docker.com/reference/compose-file/services/) for the supplied container restrictions.

## Recovery

For a local data directory:

    node scripts/recovery.mjs snapshot data NEW_SNAPSHOT_DIRECTORY
    node scripts/recovery.mjs restore SNAPSHOT_DIRECTORY NEW_DATA_DIRECTORY

For Docker, mount a protected backup directory at /backups and run the included scripts/recovery.mjs in the app container. Snapshots include the vault key needed to decrypt stored credentials. Copy snapshots to protected storage on another machine. Checksums detect corruption, not malicious replacement of both files and manifest. Never restore into a live or existing data directory. Stop the old deployment before switching to a verified restored volume. Validate accounts, provider decryption, configuration history and a smoke request before directing traffic to it.

The automated recovery drill verifies configuration history, workspace policies, vault-key preservation, corruption rejection and overwrite rejection. Off-host disaster recovery, measured recovery times and production failover still need the actual server and storage destination.

## Workspace policies and provisioning

Operations → Access → Workspace execution policy manages provider allowlists, registered tool allowlists, output-token caps and judge/guard requirements. Changes are versioned and audited; restrictive policies can intentionally block existing configurations. A disabled configuration can still be saved for emergency stopping without bypassing execution checks. Separate judge budgets are outside the configuration-generation token cap.

SCIM /scim/v2/Groups supports User members, equality filtering, pagination and version-aware mutations. Administrator authentication and tenant boundaries are enforced. Groups organize provisioned users without implicit role escalation. Bulk, sorting, nested groups and full conformance certification are not provided.

## Verified deployment boundary

scripts/production-check.mjs tests a disposable three-worker container through Caddy on loopback with a read-only filesystem, dropped capabilities and no-new-privileges. It verifies pages, updated policy assets, authenticated policy access and unauthenticated rejection, then removes only its own labeled containers/network.

This deployment is one host with local SQLite. It is not multi-region active-active infrastructure and does not demonstrate a 99.99% availability guarantee. No server, domain, paid account or off-host storage was invented or provisioned.
