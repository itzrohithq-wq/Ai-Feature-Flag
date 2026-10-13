import { randomUUID } from 'node:crypto';

export async function hostedWork(app) {
  const db = app.store.db;
  const owner = randomUUID();
  const lease = JSON.stringify({ owner, expiresAt: Date.now() + 360000 });
  const claimed = db.prepare("INSERT INTO platform_keys(name,value) VALUES ('serverless-worker',?) ON CONFLICT(name) DO UPDATE SET value=excluded.value WHERE CAST(platform_keys.value::jsonb->>'expiresAt' AS BIGINT)<? RETURNING name").get(lease, Date.now());
  if (!claimed) return { busy: true };
  try {
    app.operations.recoverJobs();
    await app.operations.workOnce({ maxItems: 1 });
    await app.delivery.tick();
    return { busy: false };
  } finally {
    db.prepare("DELETE FROM platform_keys WHERE name='serverless-worker' AND value=?").run(lease);
  }
}
