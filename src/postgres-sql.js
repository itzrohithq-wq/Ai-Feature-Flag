// Translate only the small, fixed SQL dialect used by our repositories. Values
// remain bound parameters. This is not an arbitrary user SQL endpoint.
export function postgresSql(input) {
  const pragma = /^PRAGMA table_info\(([a-z_]+)\)$/i.exec(input.trim());
  if (pragma) return { text: 'SELECT column_name AS name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1', values: [pragma[1]] };
  let sql = input.replace(/PRAGMA (?:journal_mode|busy_timeout)=[^;]+;/g, '');
  sql = sql.replace(/CREATE TRIGGER IF NOT EXISTS (\w+) BEFORE UPDATE ON (\w+) BEGIN SELECT RAISE\(ABORT,'([^']+)'\); END;/g,
    (_, name, table) => `CREATE OR REPLACE FUNCTION reject_immutable_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Immutable record'; END; $$; DROP TRIGGER IF EXISTS ${name} ON ${table}; CREATE TRIGGER ${name} BEFORE UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION reject_immutable_update();`);
  sql = sql.replace(/CREATE TABLE IF NOT EXISTS ([\w]+)\s*\(([\s\S]*?)\);/g, (_, table, fields) => `CREATE TABLE IF NOT EXISTS ${table} (${fields}, _sequence BIGINT GENERATED ALWAYS AS IDENTITY);`);
  // Some constructors omit the trailing semicolon.
  sql = sql.replace(/^(CREATE TABLE IF NOT EXISTS [\w]+\s*\([\s\S]*)(\))$/, '$1, _sequence BIGINT GENERATED ALWAYS AS IDENTITY$2');
  sql = sql.replace(/\bINTEGER\b/g, 'BIGINT');
  sql = sql.replace(/\b(?:d\.)?rowid\b/g, match => match.startsWith('d.') ? 'd._sequence' : '_sequence');
  sql = sql.replace(/json_extract\((\w+),'\$\.([\w.]+)'\)/g, (_, column, path) => `(${column}::jsonb #>> '{${path.split('.').join(',')}}')`);
  sql = sql.replace(/\(document::jsonb #>> '\{enabled\}'\)=1/g, "(document::jsonb #>> '{enabled}')='true'");
  sql = sql.replace(/displayName=\? COLLATE NOCASE/g, 'lower(displayName)=lower(?)').replace(/displayName COLLATE NOCASE/g, 'lower(displayName)');
  const ignore = /INSERT OR IGNORE/i.test(sql);
  sql = sql.replace(/INSERT OR IGNORE/gi, 'INSERT');
  if (ignore) sql = sql.trim().replace(/;$/, '') + ' ON CONFLICT DO NOTHING';
  let index = 0;
  // Quoted string contents (JSON paths, status literals, messages) are untouched.
  sql = sql.replace(/'(?:''|[^'])*'|\?/g, token => token === '?' ? `$${++index}` : token);
  return { text: sql };
}

const fields = ['createdAt','updatedAt','expiresAt','readAt','dueAt','nextAttempt','expectedVersion','traceId','spanId','firstBreach','lastAction','startedAt','displayName','externalId','pendingMfa','lastCounter','oidcSubject'];
const names = new Map(fields.map(name => [name.toLowerCase(), name]));
export function repositoryRow(row) {
  return Object.fromEntries(Object.entries(row).filter(([name]) => name !== '_sequence').map(([name, value]) => [names.get(name) ?? name, value]));
}
