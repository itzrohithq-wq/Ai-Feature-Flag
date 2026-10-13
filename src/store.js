import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateFlag, evaluate } from './engine.js';

export class Store {
  constructor(path = ':memory:', database) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = database ?? new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS versions (tenant TEXT, environment TEXT, key TEXT, version INTEGER, config TEXT NOT NULL, PRIMARY KEY(tenant,environment,key,version));
      CREATE TABLE IF NOT EXISTS audit (id TEXT PRIMARY KEY, tenant TEXT, actor TEXT, action TEXT, environment TEXT, key TEXT, version INTEGER, timestamp TEXT);
      CREATE TABLE IF NOT EXISTS exposures (id TEXT PRIMARY KEY, tenant TEXT, environment TEXT, key TEXT, version INTEGER, reason TEXT, value TEXT, timestamp TEXT);
      CREATE TRIGGER IF NOT EXISTS immutable_versions BEFORE UPDATE ON versions BEGIN SELECT RAISE(ABORT,'Immutable versions'); END;
      CREATE TRIGGER IF NOT EXISTS immutable_audit BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT,'Immutable audit'); END;`);
  }
  get(tenant, environment, key) {
    const row = this.db.prepare('SELECT config FROM versions WHERE tenant=? AND environment=? AND key=? ORDER BY version DESC LIMIT 1').get(tenant, environment, key);
    if (!row) throw Object.assign(new Error('Flag not found in this workspace and environment.'), { status: 404, code: 'NOT_FOUND' });
    return JSON.parse(row.config);
  }
  list(tenant, environment) {
    return this.db.prepare('SELECT config FROM versions v WHERE tenant=? AND environment=? AND version=(SELECT MAX(version) FROM versions WHERE tenant=v.tenant AND environment=v.environment AND key=v.key) ORDER BY key').all(tenant, environment).map(row => JSON.parse(row.config));
  }
  save(tenant, actor, input, expectedVersion, action = 'save') {
    const flag = validateFlag(input);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.db.prepare('SELECT MAX(version) AS version FROM versions WHERE tenant=? AND environment=? AND key=?').get(tenant, flag.environment, flag.key).version ?? 0;
      if (expectedVersion !== previous) throw Object.assign(new Error('This flag changed. Reload before saving.'), { status: 409, code: 'VERSION_CONFLICT' });
      const next = { ...flag, version: previous + 1, updatedAt: new Date().toISOString() };
      this.db.prepare('INSERT INTO versions VALUES (?,?,?,?,?)').run(tenant, flag.environment, flag.key, next.version, JSON.stringify(next));
      this.db.prepare('INSERT INTO audit VALUES (?,?,?,?,?,?,?,?)').run(randomUUID(), tenant, actor, action, flag.environment, flag.key, next.version, next.updatedAt);
      this.db.exec('COMMIT');
      return next;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  history(tenant, environment, key) {
    return this.db.prepare('SELECT config FROM versions WHERE tenant=? AND environment=? AND key=? ORDER BY version DESC').all(tenant, environment, key).map(row => JSON.parse(row.config));
  }
  audit(tenant) { return this.db.prepare('SELECT * FROM audit WHERE tenant=? ORDER BY timestamp DESC LIMIT 100').all(tenant).map(({ tenant: ignored, ...row }) => row); }
  decide(tenant, environment, key, context) {
    const result = { ...evaluate(this.get(tenant, environment, key), context, tenant), traceId: randomUUID(), timestamp: new Date().toISOString() };
    this.db.prepare('INSERT INTO exposures VALUES (?,?,?,?,?,?,?,?)').run(result.traceId, tenant, environment, key, result.version, result.reason, JSON.stringify(result.value), result.timestamp);
    return result;
  }
  stats(tenant, environment) {
    return this.db.prepare('SELECT key, version, reason, value, COUNT(*) AS count FROM exposures WHERE tenant=? AND environment=? GROUP BY key,version,reason,value ORDER BY key,version').all(tenant, environment);
  }
  close() { this.db.close(); }
}
