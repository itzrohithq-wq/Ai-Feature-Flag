import { Store } from './store.js';
import { PostgresDatabase } from './postgres-database.js';
import { createApp } from './server.js';
import { providersFromEnvironment } from './providers.js';

export function createHostedApp({ connectionString = process.env.DATABASE_URL, token = process.env.FLAG_ADMIN_TOKEN, vaultKey = process.env.RUNTIME_VAULT_KEY, tenant = 'hosted-workspace', providers = providersFromEnvironment() } = {}) {
  if (!token || token.length < 32 || !/^[a-f0-9]{64}$/i.test(vaultKey ?? '')) throw new Error('Configure a persistent owner token and 32-byte vault key before deployment.');
  const db = new PostgresDatabase(connectionString);
  db.exec('BEGIN IMMEDIATE');
  try {
    const store = new Store(':memory:', db);
    const app = createApp({ store, credentials: [{ token, tenant, actor: 'workspace-owner', role: 'owner' }], vaultKey, providers, requireProductionApproval: true, workerMode: 'disabled' });
    db.exec('COMMIT');
    app.store = store;
    return app;
  } catch (error) { try { db.exec('ROLLBACK'); } finally { db.close(); } throw error; }
}
