import { parentPort, workerData } from 'node:worker_threads';
import { Client, types } from 'pg';
import { postgresSql, repositoryRow } from './postgres-sql.js';

types.setTypeParser(20, value => { const number = Number(value); if (!Number.isSafeInteger(number)) throw new Error('Unsafe integer from database'); return number; });
const client = new Client({ connectionString: workerData.connectionString, connectionTimeoutMillis: 10000, statement_timeout: 20000, idle_in_transaction_session_timeout: 25000 });
client.on('error', () => { /* Per-command failures are returned without credentials. */ });
let ready = client.connect();
function answer(buffer, value) {
  const state = new Int32Array(buffer, 0, 2);
  let bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > buffer.byteLength - 8) bytes = Buffer.from(JSON.stringify({ error: { message: 'Database result exceeds response limit.', code: 'RESULT_TOO_LARGE' } }));
  new Uint8Array(buffer, 8).set(bytes);
  Atomics.store(state, 1, bytes.length);
  Atomics.store(state, 0, 1);
  Atomics.notify(state, 0);
}
parentPort.on('message', async ({ sql, values, mode, buffer }) => {
  try {
    await ready;
    if (mode === 'close') { await client.end(); answer(buffer, { value: null }); return; }
    if (sql === 'BEGIN IMMEDIATE') {
      await client.query('BEGIN');
      // Match SQLite's single-writer transaction semantics across all instances.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('control-studio-write',0))");
      answer(buffer, { value: null }); return;
    }
    const translated = postgresSql(sql);
    if (!translated.text.trim()) { answer(buffer, { value: null }); return; }
    const result = await client.query(translated.text, translated.values ?? values);
    const last = Array.isArray(result) ? result.at(-1) : result;
    const rows = (last?.rows ?? []).map(repositoryRow);
    answer(buffer, { value: mode === 'get' ? rows[0] ?? null : mode === 'all' ? rows : { changes: last?.rowCount ?? 0 } });
  } catch (error) {
    // Never return connection strings, SQL parameters, or PostgreSQL detail fields.
    answer(buffer, { error: { message: 'Hosted database operation failed.', code: error.code ?? 'DATABASE_ERROR' } });
  }
});
