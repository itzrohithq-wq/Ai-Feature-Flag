import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { evaluate, validateFlag } from '../src/engine.js';
import { createApp } from '../src/server.js';
import { FlagClient } from '../src/sdk.js';

const flag = (changes = {}) => ({ key: 'ai-summary', environment: 'development', type: 'boolean', enabled: true, rollout: 100, targets: [], defaultValue: false, value: true, ...changes });
test('rollout, targeting and emergency stop preserve defaults', () => {
  const context = { userId: 'one', cohort: 'beta' };
  assert.equal(evaluate(flag(), context, 'a').value, true);
  assert.equal(evaluate(flag({ enabled: false }), context, 'a').reason, 'disabled');
  assert.equal(evaluate(flag({ rollout: 0 }), context, 'a').reason, 'outside_rollout');
  assert.equal(evaluate(flag({ targets: ['enterprise'] }), context, 'a').reason, 'not_targeted');
  assert.equal(evaluate(flag({ targets: ['beta'] }), context, 'a').value, true);
});
test('assignments repeat and rollout expands without evicting existing users', () => {
  let included = 0;
  for(let n=0;n<1000;n++) {
    const context = { userId: String(n) };
    const first = evaluate(flag({ rollout: 30 }), context, 'a');
    assert.deepEqual(first, evaluate(flag({ rollout: 30 }), context, 'a'));
    if(first.value) { included++; assert.equal(evaluate(flag({ rollout: 60 }), context, 'a').value, true); }
  }
  assert.ok(included > 240 && included < 360);
});
test('multivariate configuration validates weights and assigns deterministically', () => {
  const config = validateFlag(flag({ type: 'multivariate', defaultValue: 'base', variants: [{ value: 'a', weight: 40 }, { value: 'b', weight: 60 }] }));
  const counts = { a: 0, b: 0 };
  for(let n=0;n<1000;n++) counts[evaluate(config, { userId: String(n) }, 'a').value]++;
  assert.ok(counts.a > 330 && counts.a < 470);
  assert.throws(() => validateFlag({ ...config, variants: [{value:'a',weight:1},{value:'b',weight:1}] }));
  assert.throws(() => validateFlag(flag({ rollout: -1 })));
});
test('persistent immutable versions, concurrency and tenant/environment boundaries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'flags-')); const path = join(dir, 'test.sqlite');
  let store = new Store(path);
  try {
    store.save('a', 'owner', flag(), 0);
    assert.throws(() => store.save('a', 'owner', flag(), 0), { code: 'VERSION_CONFLICT' });
    store.save('a', 'owner', flag({ enabled: false }), 1, 'kill');
    assert.equal(store.history('a', 'development', 'ai-summary').length, 2);
    assert.throws(() => store.get('b', 'development', 'ai-summary'), { code: 'NOT_FOUND' });
    assert.throws(() => store.get('a', 'production', 'ai-summary'), { code: 'NOT_FOUND' });
    store.decide('a', 'development', 'ai-summary', { userId: 'secret-user' });
    assert.equal(store.stats('a', 'development')[0].count, 1);
    assert.ok(!JSON.stringify(store.stats('a', 'development')).includes('secret-user'));
    store.close(); store = new Store(path); assert.equal(store.get('a', 'development', 'ai-summary').enabled, false);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('API authorization, isolation, conflicts, kill, malformed input and SDK fallback', async () => {
  const store = new Store();
  const credentials = [{token:'owner-a',tenant:'a',actor:'owner',role:'owner'},{token:'reader-a',tenant:'a',actor:'reader',role:'read-only'},{token:'owner-b',tenant:'b',actor:'owner',role:'owner'}];
  const app = createApp({ store, credentials }); await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${app.address().port}`;
  const request = (path, token, method='GET', body) => fetch(baseUrl+path, {method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body ? {body:JSON.stringify(body)} : {})});
  try {
    assert.equal((await request('/api/flags','bad')).status,401);
    assert.equal((await request('/api/flags/ai-summary','reader-a','PUT',{...flag(),expectedVersion:0})).status,403);
    assert.equal((await request('/api/flags/ai-summary','owner-a','PUT',{...flag(),expectedVersion:0})).status,200);
    assert.equal((await request('/api/flags/ai-summary','owner-b')).status,404);
    assert.equal((await request('/api/flags/ai-summary','owner-a','PUT',{...flag(),expectedVersion:0})).status,409);
    const client = new FlagClient({baseUrl,token:'reader-a'});
    assert.equal((await client.evaluate('ai-summary',{userId:'one'})).value,true);
    assert.equal((await request('/api/flags/ai-summary/kill','owner-a','POST',{expectedVersion:1})).status,200);
    assert.equal((await client.evaluate('ai-summary',{userId:'one'})).reason,'disabled');
    assert.equal((await request('/api/flags/ai-summary/evaluate','owner-a','POST',{})).status,400);
    assert.equal((await request('/api/flags?environment=invalid','owner-a')).status,400);
    assert.equal((await new FlagClient({baseUrl,token:'bad'}).evaluate('ai-summary',{userId:'one'},'safe')).value,'safe');
    assert.equal((await fetch(baseUrl+'/')).status,200);
    assert.equal((await fetch(baseUrl+'/app.js')).status,200);
    for (const path of ['/welcome', '/welcome.css', '/welcome.js']) {
      assert.equal((await fetch(baseUrl+path)).status,200);
    }
  } finally { await new Promise(resolve => app.close(resolve)); store.close(); }
});
