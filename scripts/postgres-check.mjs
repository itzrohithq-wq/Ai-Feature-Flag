import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { createHostedApp } from '../src/hosted-app.js';
import { hostedWork } from '../src/hosted-worker.js';

const token = randomBytes(32).toString('hex');
const tenant = `verification-${randomBytes(8).toString('hex')}`;
const vaultKey = randomBytes(32).toString('hex');
const providers = { custom: async () => ({ output: 'yes' }) };
const app = createHostedApp({ token, vaultKey, tenant, providers });
app.listen(0, '127.0.0.1');
await once(app, 'listening');
const base = `http://127.0.0.1:${app.address().port}`;
const call = async (path, method = 'GET', body) => {
  const response = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Connection:'close' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json();
  assert.ok(response.ok, `${method} ${path}: ${JSON.stringify(data)}`);
  return data;
};
try {
  assert.equal((await call('/api/session')).role, 'owner');
  await call('/api/flags');
  await call('/api/runtime/configs');
  await call('/api/runtime/jobs');
  await call('/api/runtime/traces');
  await call('/api/runtime/notifications');
  const flag = { key:'hosted-check',type:'boolean',enabled:true,rollout:100,targets:[],defaultValue:false,value:true,expectedVersion:0 };
  await call('/api/flags/hosted-check', 'PUT', flag);
  assert.equal((await call('/api/flags/hosted-check/evaluate','POST',{userId:'fixture'})).value,true);
  await call('/api/flags/hosted-check/kill','POST',{expectedVersion:1});
  assert.equal((await call('/api/flags/hosted-check/evaluate','POST',{userId:'fixture'})).value,false);
  assert.equal((await call('/api/flags/hosted-check/history')).length,2);
  const r = app.operations.runtime;
  const config = {key:'hosted-config',mode:'completion',enabled:true,defaultVariation:'baseline',variations:[{id:'baseline',provider:'custom',model:'fixture',weight:100,messages:[{role:'system',content:'Help'}]}]};
  r.save(tenant,'development','fixture','configs',config,0);
  r.save(tenant,'development','fixture','datasets',{key:'hosted-dataset',rows:[{id:'one',input:'question',expected:'yes'},{id:'two',input:'question',expected:'yes'}]},0);
  r.save(tenant,'development','fixture','judges',{key:'hosted-judge',type:'exact'},0);
  const identity={tenant,actor:'fixture',role:'owner'};
  const job=app.operations.enqueue(identity,'development',{config:'hosted-config',dataset:'hosted-dataset',judge:'hosted-judge',variations:['baseline'],allowProviderCalls:true});
  for(let i=0;i<3;i++)await hostedWork(app);
  assert.equal(app.operations.job(tenant,'development',job.id).status,'completed');
  assert.equal(app.operations.job(tenant,'development',job.id).completed,2);
  const group=await call('/scim/v2/Groups','POST',{displayName:'Hosted Check',members:[]});
  assert.equal((await call('/scim/v2/Groups?filter='+encodeURIComponent('displayName eq "hosted check"'))).Resources[0].id,group.id);
  await app.access.create(identity,{actor:'fixture-reader',role:'reader',password:randomBytes(20).toString('hex')});
  const issued=app.operations.issue(identity,{actor:'fixture-service',role:'reader',days:1,policy:{environments:['development'],resources:['configs/hosted-config']}});
  assert.equal(app.operations.authenticate(issued.token).policy.resources[0],'configs/hosted-config');
  app.operations.revoke(identity,issued.id);
  assert.equal(app.operations.authenticate(issued.token),null);
  assert.throws(()=>app.store.db.prepare('UPDATE versions SET config=? WHERE tenant=?').run('{}',tenant));
  assert.throws(()=>r.get('other-tenant','development','configs','hosted-config'),{code:'NOT_FOUND'});
  const other = createHostedApp({token,vaultKey,tenant,providers});
  other.listen(0,'127.0.0.1');await once(other,'listening');
  try {
    const edit=async url=>fetch(url+'/api/flags/concurrent-check',{method:'PUT',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(flag)});
    const responses=await Promise.all([edit(base),edit(`http://127.0.0.1:${other.address().port}`)]);
    assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);
  } finally {await new Promise(resolve=>other.close(resolve));other.store.close();}
  console.log('Hosted PostgreSQL: flag lifecycle, runtime, checkpointed evaluation, SCIM filtering, access/revocation, immutable history, isolation and cross-instance conflicts passed. No paid provider calls.');
} finally {
  const tables=['versions','audit','exposures','runtime_resources','runtime_executions','runtime_assignments','runtime_alerts','runtime_evals','runtime_rollouts','runtime_graph_runs','runtime_approvals','runtime_playgrounds','runtime_trigger_state','enterprise_policies','platform_tokens','platform_secrets','evaluation_jobs','telemetry_spans','notifications','scheduled_changes','scim_groups','scim_users','platform_users','notification_channels','release_plans','judge_calibrations'];
  for(const table of tables)app.store.db.prepare(`DELETE FROM ${table} WHERE tenant=?`).run(tenant);
  await new Promise(resolve => app.close(resolve)); app.store.close();
}
