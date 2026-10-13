import test from 'node:test';
import assert from 'node:assert/strict';
import { postgresSql, repositoryRow } from '../src/postgres-sql.js';

test('hosted SQL binds parameters without changing quoted literal question marks', () => {
  assert.equal(postgresSql("SELECT '?' AS label FROM versions WHERE tenant=? AND key=?").text, "SELECT '?' AS label FROM versions WHERE tenant=$1 AND key=$2");
});
test('hosted SQL preserves JSON comparisons and case-insensitive SCIM matching', () => {
  assert.equal(postgresSql("SELECT * FROM runtime_resources WHERE json_extract(document,'$.enabled')=1 AND json_extract(document,'$.guard.maxWaitSeconds') IS NOT NULL").text, "SELECT * FROM runtime_resources WHERE (document::jsonb #>> '{enabled}')='true' AND (document::jsonb #>> '{guard,maxWaitSeconds}') IS NOT NULL");
  assert.equal(postgresSql('SELECT id FROM scim_groups WHERE displayName=? COLLATE NOCASE').text,'SELECT id FROM scim_groups WHERE lower(displayName)=lower($1)');
});
test('hosted SQL preserves ignore-on-conflict semantics and deterministic row ordering', () => {
  assert.equal(postgresSql("INSERT OR IGNORE INTO notifications SELECT id,tenant,environment,details,NULL FROM runtime_alerts;").text,"INSERT INTO notifications SELECT id,tenant,environment,details,NULL FROM runtime_alerts ON CONFLICT DO NOTHING");
  assert.equal(postgresSql('SELECT d.channel FROM notification_deliveries d ORDER BY d.rowid DESC').text,'SELECT d.channel FROM notification_deliveries d ORDER BY d._sequence DESC');
});
test('hosted rows preserve API casing and omit internal ordering column', () => {
  assert.deepEqual(repositoryRow({traceid:'trace',createdat:'date',expectedversion:2,_sequence:10}),{traceId:'trace',createdAt:'date',expectedVersion:2});
});
test('hosted DDL retains primary keys and adds ordering after application columns', () => {
  assert.equal(postgresSql('CREATE TABLE IF NOT EXISTS example(id TEXT PRIMARY KEY,value INTEGER);').text,'CREATE TABLE IF NOT EXISTS example (id TEXT PRIMARY KEY,value BIGINT, _sequence BIGINT GENERATED ALWAYS AS IDENTITY);');
});
