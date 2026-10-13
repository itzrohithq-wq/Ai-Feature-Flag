import { Worker } from 'node:worker_threads';

// Keep repository transactions synchronous without rewriting their domain logic.
// Network I/O runs on a dedicated worker. This serializes DB calls per instance;
// it is intended for modest workloads, not a high-throughput connection pool.
export class PostgresDatabase {
  constructor(connectionString) {
    if (!connectionString) throw new Error('DATABASE_URL is required.');
    const url = new URL(connectionString);
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('Expected a PostgreSQL connection.');
    url.searchParams.set('sslmode', 'verify-full');
    this.dialect = 'postgres';
    this.worker = new Worker(new URL('./postgres-worker.js', import.meta.url), { workerData: { connectionString: url.href }, execArgv: [] });
    this.worker.on('error', () => { this.failed = true; });
    this.worker.unref();
    this.buffer = new SharedArrayBuffer(16 * 1024 * 1024);
  }
  command(sql, values = [], mode = 'run') {
    if (this.failed || this.closed) throw new Error('Hosted database connection is unavailable.');
    const buffer = this.buffer;
    const state = new Int32Array(buffer, 0, 2);
    Atomics.store(state, 0, 0);
    Atomics.store(state, 1, 0);
    this.worker.postMessage({ sql, values, mode, buffer });
    if (Atomics.wait(state, 0, 0, 30000) === 'timed-out') {
      this.failed = true;
      this.worker.terminate();
      throw new Error('Hosted database operation timed out. Reload before retrying a write.');
    }
    const result = JSON.parse(Buffer.from(new Uint8Array(buffer, 8, Atomics.load(state, 1))).toString());
    if (result.error) throw Object.assign(new Error(result.error.message), { code: result.error.code });
    return result.value ?? undefined;
  }
  exec(sql) { return this.command(sql, [], 'exec'); }
  prepare(sql) { return { get: (...values) => this.command(sql, values, 'get'), all: (...values) => this.command(sql, values, 'all'), run: (...values) => this.command(sql, values, 'run') }; }
  close() { if (!this.closed) { if (!this.failed) this.command('', [], 'close'); this.closed = true; this.worker.terminate(); } }
}
