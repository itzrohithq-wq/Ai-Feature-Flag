import {randomUUID,randomBytes,createHash,createCipheriv,createDecipheriv,generateKeyPairSync,createPrivateKey,createPublicKey} from 'node:crypto';
import {fail} from './runtime-schema.js';
import {generate} from './playground.js';
import {openaiAdapter,anthropicAdapter,geminiAdapter} from './providers.js';
import {builtInTools} from './tool-execution.js';

const digest=value=>createHash('sha256').update(value).digest('hex');
const now=()=>new Date().toISOString();
const roles=['admin','operator','reviewer','reader'];
export class Operations {
  constructor(runtime,{vaultKey,providers={},toolHandlers=builtInTools}={}) {
    this.runtime=runtime;this.db=runtime.db;this.providers=providers;this.toolHandlers=toolHandlers;this.active=false;this.closed=false;
    if(vaultKey){this.key=Buffer.from(vaultKey,'hex');if(this.key.length!==32||!/^[a-f0-9]{64}$/i.test(vaultKey))throw new Error('RUNTIME_VAULT_KEY must be 32 bytes encoded as 64 hex characters.');}
    this.db.exec(`CREATE TABLE IF NOT EXISTS platform_tokens(id TEXT PRIMARY KEY,tenant TEXT,actor TEXT,role TEXT,hash TEXT UNIQUE,expiresAt INTEGER,revoked INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS platform_secrets(tenant TEXT,name TEXT,encrypted TEXT,updatedAt TEXT,PRIMARY KEY(tenant,name));
      CREATE TABLE IF NOT EXISTS platform_keys(name TEXT PRIMARY KEY,value TEXT);
      CREATE TABLE IF NOT EXISTS evaluation_jobs(id TEXT PRIMARY KEY,tenant TEXT,environment TEXT,actor TEXT,status TEXT,input TEXT,outputs TEXT,result TEXT,error TEXT,createdAt TEXT,updatedAt TEXT);
      CREATE TABLE IF NOT EXISTS telemetry_spans(tenant TEXT,environment TEXT,traceId TEXT,spanId TEXT,document TEXT,PRIMARY KEY(tenant,environment,traceId,spanId));
      CREATE TABLE IF NOT EXISTS notifications(id TEXT PRIMARY KEY,tenant TEXT,environment TEXT,document TEXT,readAt TEXT);
      CREATE TABLE IF NOT EXISTS scheduled_changes(id TEXT PRIMARY KEY,tenant TEXT,environment TEXT,actor TEXT,kind TEXT,key TEXT,expectedVersion INTEGER,document TEXT,dueAt TEXT,status TEXT,error TEXT);`);
    if(!this.db.prepare('PRAGMA table_info(platform_tokens)').all().some(c=>c.name==='policy'))this.db.exec('ALTER TABLE platform_tokens ADD COLUMN policy TEXT');
    if(!this.db.prepare('PRAGMA table_info(scheduled_changes)').all().some(c=>c.name==='reviewer'))this.db.exec('ALTER TABLE scheduled_changes ADD COLUMN reviewer TEXT');
    let signing=this.db.prepare("SELECT value FROM platform_keys WHERE name='signing'").get();
    if(!signing){const pair=generateKeyPairSync('ed25519');this.db.prepare('INSERT OR IGNORE INTO platform_keys VALUES (?,?)').run('signing',pair.privateKey.export({type:'pkcs8',format:'pem'}));signing=this.db.prepare("SELECT value FROM platform_keys WHERE name='signing'").get();}
    runtime.signing={privateKey:createPrivateKey(signing.value),publicKey:createPublicKey(signing.value)};
  }
  audit(identity,action,key,environment='development') {this.db.prepare('INSERT INTO audit VALUES (?,?,?,?,?,?,?,?)').run(randomUUID(),identity.tenant,identity.actor,action,environment,key,0,now());}
  authenticate(token){const row=this.db.prepare('SELECT * FROM platform_tokens WHERE hash=? AND revoked=0 AND expiresAt>?').get(digest(token),Date.now());return row?{tenant:row.tenant,actor:row.actor,role:row.role,credentialId:row.id,policy:row.policy?JSON.parse(row.policy):null}:null;}
  tokens(tenant){return this.db.prepare('SELECT id,actor,role,expiresAt,revoked,policy FROM platform_tokens WHERE tenant=? ORDER BY expiresAt DESC').all(tenant).map(r=>({...r,policy:r.policy?JSON.parse(r.policy):null}));}
  issue(identity,input) {
    if(!roles.includes(input.role)||typeof input.actor!=='string'||!input.actor.trim()||input.actor.length>128||!Number.isInteger(input.days)||input.days<1||input.days>365)fail('Supply actor, role (admin/operator/reviewer/reader), and days 1–365.');
    const token=randomBytes(32).toString('hex'),id=randomUUID(),expiresAt=Date.now()+input.days*86400000;
    const policy=input.policy??{environments:['development','staging','production'],resources:['*']};
    if(!Array.isArray(policy.environments)||!policy.environments.length||policy.environments.length>3||policy.environments.some(e=>!['development','staging','production'].includes(e))||!Array.isArray(policy.resources)||!policy.resources.length||policy.resources.length>30||policy.resources.some(r=>typeof r!=='string'||!['*','telemetry'].includes(r)&&!/^(configs|datasets|judges|graphs|models|tools|segments|snippets)\/[a-z][a-z0-9-]{1,63}$/.test(r)))fail('Credential policy needs known environments and resource paths, telemetry, or *.');
    if(identity.policy&&(policy.environments.some(e=>!identity.policy.environments.includes(e))||!identity.policy.resources.includes('*')&&policy.resources.some(r=>!identity.policy.resources.includes(r))))fail('Cannot grant broader access than your own credential.','FORBIDDEN',403);
    this.db.prepare('INSERT INTO platform_tokens(id,tenant,actor,role,hash,expiresAt,revoked,policy) VALUES (?,?,?,?,?,?,0,?)').run(id,identity.tenant,input.actor,input.role,digest(token),expiresAt,JSON.stringify(policy));
    this.audit(identity,'credential_created',id);return {id,token,expiresAt};
  }
  revoke(identity,id){if(!this.db.prepare('UPDATE platform_tokens SET revoked=1 WHERE id=? AND tenant=?').run(id,identity.tenant).changes)fail('Credential not found.','NOT_FOUND',404);this.audit(identity,'credential_revoked',id);return {revoked:true};}
  seal(value){if(!this.key)fail('Configure RUNTIME_VAULT_KEY on the server before storing provider secrets.','VAULT_NOT_CONFIGURED',409);const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key,iv);return JSON.stringify({iv:iv.toString('hex'),tag:null,data:Buffer.concat([cipher.update(value,'utf8'),cipher.final()]).toString('hex'),...{tag:cipher.getAuthTag().toString('hex')}});}
  unseal(value){const v=JSON.parse(value),cipher=createDecipheriv('aes-256-gcm',this.key,Buffer.from(v.iv,'hex'));cipher.setAuthTag(Buffer.from(v.tag,'hex'));return Buffer.concat([cipher.update(Buffer.from(v.data,'hex')),cipher.final()]).toString('utf8');}
  putSecret(identity,name,value){if(!['openai','anthropic','gemini'].includes(name)||typeof value!=='string'||value.length<8||value.length>4096)fail('Choose OpenAI, Anthropic or Gemini and supply a valid credential.');const encrypted=this.seal(value);this.db.prepare('INSERT INTO platform_secrets VALUES (?,?,?,?) ON CONFLICT(tenant,name) DO UPDATE SET encrypted=excluded.encrypted,updatedAt=excluded.updatedAt').run(identity.tenant,name,encrypted,now());this.audit(identity,'provider_credential_updated',name);return {name,configured:true};}
  removeSecret(identity,name){this.db.prepare('DELETE FROM platform_secrets WHERE tenant=? AND name=?').run(identity.tenant,name);this.audit(identity,'provider_credential_removed',name);return {removed:true};}
  providerSet(tenant){const result={...this.providers};if(this.key)for(const row of this.db.prepare('SELECT name,encrypted FROM platform_secrets WHERE tenant=?').all(tenant)){const factory={openai:openaiAdapter,anthropic:anthropicAdapter,gemini:geminiAdapter}[row.name];result[row.name]=factory({apiKey:this.unseal(row.encrypted)});}return result;}
  enqueue(identity,environment,input){
    if(input.allowProviderCalls!==true)fail('Explicitly authorize provider calls.');
    const r=this.runtime,config=r.get(identity.tenant,environment,'configs',input.config,input.configVersion),dataset=r.get(identity.tenant,environment,'datasets',input.dataset,input.datasetVersion),judge=r.get(identity.tenant,environment,'judges',input.judge,input.judgeVersion);
    const variations=input.variations??config.variations.map(v=>v.id),providers=this.providerSet(identity.tenant);
    if(!Array.isArray(variations)||!variations.length||new Set(variations).size!==variations.length||variations.some(id=>!config.variations.some(v=>v.id===id))||variations.length*dataset.rows.length>1000)fail('Select unique variations and at most 1000 row/variation pairs.');
    if(variations.some(id=>!providers[config.variations.find(v=>v.id===id).provider])||(judge.type==='llm'&&!providers[judge.provider]))fail('Configure the generation and judge providers first.','PROVIDER_NOT_CONFIGURED',409);
    if(input.approvedTools!==undefined&&(!Array.isArray(input.approvedTools)||input.approvedTools.some(k=>typeof k!=='string')))fail('Approved tools must be a list.');
    for(const id of variations){const variation=config.variations.find(v=>v.id===id),provider=providers[variation.provider];if(dataset.rows.some(row=>row.attachments?.length)&&!provider.capabilities?.images)fail('Selected provider does not support dataset images.','UNSUPPORTED_CAPABILITY',409);if(variation.tools?.length&&(input.allowToolCalls!==true||!provider.capabilities?.tools||variation.toolDefinitions.some(d=>!Object.hasOwn(this.toolHandlers,d.key)||typeof this.toolHandlers[d.key]!=='function'||d.requiresApproval&&!input.approvedTools?.includes(d.key))))fail('Authorize and register every selected tool before queueing the job.','TOOL_APPROVAL_REQUIRED',409);}
    const pinned={config:config.key,configVersion:config.version,dataset:dataset.key,datasetVersion:dataset.version,judge:judge.key,judgeVersion:judge.version,variations,allowToolCalls:input.allowToolCalls===true,approvedTools:input.approvedTools??[]};
    const id=randomUUID(),date=now();this.db.prepare('INSERT INTO evaluation_jobs VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id,identity.tenant,environment,identity.actor,'queued',JSON.stringify(pinned),'[]',null,null,date,date);this.audit(identity,'evaluation_job_created',id,environment);return this.job(identity.tenant,environment,id);
  }
  job(tenant,environment,id){const row=this.db.prepare('SELECT * FROM evaluation_jobs WHERE tenant=? AND environment=? AND id=?').get(tenant,environment,id);if(!row)fail('Job not found.','NOT_FOUND',404);const input=JSON.parse(row.input);const dataset=this.runtime.get(tenant,environment,'datasets',input.dataset,input.datasetVersion);return {id:row.id,status:row.status,input,completed:JSON.parse(row.outputs).length,total:dataset.rows.length*input.variations.length,result:row.result?JSON.parse(row.result):null,error:row.error,createdAt:row.createdAt,updatedAt:row.updatedAt};}
  jobs(tenant,environment){return this.db.prepare('SELECT id FROM evaluation_jobs WHERE tenant=? AND environment=? ORDER BY createdAt DESC LIMIT 100').all(tenant,environment).map(r=>this.job(tenant,environment,r.id));}
  jobAction(identity,environment,id,action){const job=this.job(identity.tenant,environment,id);if(action==='cancel'&&['queued','running'].includes(job.status))this.db.prepare("UPDATE evaluation_jobs SET status='cancelled',updatedAt=? WHERE id=?").run(now(),id);else if(action==='resume'&&['cancelled','failed'].includes(job.status))this.db.prepare("UPDATE evaluation_jobs SET status='queued',error=NULL,updatedAt=? WHERE id=?").run(now(),id);else fail('This job cannot perform that action.','JOB_STATE',409);this.audit(identity,`job_${action}`,id,environment);return this.job(identity.tenant,environment,id);}
  async workOnce({maxItems=Infinity}={}){
    if(this.active||this.closed)return;this.active=true;
    try {
      this.collectNotifications();this.runSchedules();
      const controlled=this.db.prepare("SELECT tenant,environment,document FROM runtime_resources r WHERE kind='configs' AND version=(SELECT MAX(version) FROM runtime_resources WHERE tenant=r.tenant AND environment=r.environment AND kind=r.kind AND key=r.key) AND json_extract(document,'$.enabled')=1 AND (json_extract(document,'$.guard.maxWaitSeconds') IS NOT NULL OR json_extract(document,'$.trigger.delaySeconds') IS NOT NULL)").all();
      for(const row of controlled)this.runtime.transaction(()=>this.runtime.automate(row.tenant,row.environment,JSON.parse(row.document)));
      const row=this.db.prepare("SELECT * FROM evaluation_jobs WHERE status='queued' ORDER BY createdAt LIMIT 1").get();if(!row)return;
      this.db.prepare("UPDATE evaluation_jobs SET status='running',updatedAt=? WHERE id=? AND status='queued'").run(now(),row.id);
      const input=JSON.parse(row.input),outputs=JSON.parse(row.outputs),dataset=this.runtime.get(row.tenant,row.environment,'datasets',input.dataset,input.datasetVersion);
      try {
        const providers=this.providerSet(row.tenant);
        let processed=0;
        for(const variation of input.variations)for(const item of dataset.rows){
          if(this.closed||this.job(row.tenant,row.environment,row.id).status!=='running')return;
          if(outputs.some(o=>o.variation===variation&&o.rowId===item.id))continue;
          if(processed>=maxItems){this.db.prepare("UPDATE evaluation_jobs SET status='queued',updatedAt=? WHERE id=? AND status='running'").run(now(),row.id);return;}
          const result=await generate(this.runtime,providers,row.tenant,row.environment,{...input,variation,input:item.input,variables:item.variables,expected:item.expected,attachments:item.attachments},{toolHandlers:this.toolHandlers});
          if(this.closed||this.job(row.tenant,row.environment,row.id).status!=='running')return;
          outputs.push({rowId:item.id,variation,output:result.output,judgement:result.evaluation});
          this.db.prepare('UPDATE evaluation_jobs SET outputs=?,updatedAt=? WHERE id=?').run(JSON.stringify(outputs),now(),row.id);
          processed++;
        }
        this.runtime.transaction(()=>{const result=this.runtime.benchmark(row.tenant,row.environment,{...input,outputs});this.db.prepare("UPDATE evaluation_jobs SET status='completed',result=?,updatedAt=? WHERE id=?").run(JSON.stringify(result),now(),row.id);});
      }catch(err){if(this.job(row.tenant,row.environment,row.id).status==='running')this.db.prepare("UPDATE evaluation_jobs SET status='failed',error=?,updatedAt=? WHERE id=?").run(err.status?err.message:'Evaluation failed; inspect provider configuration and server logs.',now(),row.id);}
    }finally{this.active=false;}
  }
  recoverJobs(){this.db.prepare("UPDATE evaluation_jobs SET status='queued' WHERE status='running'").run();}
  renewLease(){const row=this.db.prepare("SELECT value FROM platform_keys WHERE name='worker-lease'").get();const lease=row?JSON.parse(row.value):null;if(lease?.owner!==this.workerId)throw new Error('Worker lease lost.');this.db.prepare("UPDATE platform_keys SET value=? WHERE name='worker-lease'").run(JSON.stringify({owner:this.workerId,expiresAt:Date.now()+60000}));}
  start(){this.workerId=randomUUID();this.runtime.transaction(()=>{const row=this.db.prepare("SELECT value FROM platform_keys WHERE name='worker-lease'").get();if(row&&JSON.parse(row.value).expiresAt>Date.now())throw new Error('Another worker owns this database. Run one server process per SQLite store.');this.db.prepare("INSERT INTO platform_keys VALUES ('worker-lease',?) ON CONFLICT(name) DO UPDATE SET value=excluded.value").run(JSON.stringify({owner:this.workerId,expiresAt:Date.now()+60000}));this.recoverJobs();});this.timer=setInterval(()=>{try{this.renewLease();}catch{this.close();return;}this.workOnce().catch(()=>{});},1000);this.timer.unref();}
  close(){this.closed=true;clearInterval(this.timer);if(this.workerId){const row=this.db.prepare("SELECT value FROM platform_keys WHERE name='worker-lease'").get();if(row&&JSON.parse(row.value).owner===this.workerId)this.db.prepare("DELETE FROM platform_keys WHERE name='worker-lease'").run();}}
  ingest(tenant,environment,input){
    if(input.resourceSpans!==undefined&&(!Array.isArray(input.resourceSpans)||input.resourceSpans.length>200||input.resourceSpans.some(r=>!Array.isArray(r?.scopeSpans)||r.scopeSpans.some(s=>!Array.isArray(s?.spans)))))fail('resourceSpans requires arrays of scopeSpans and spans.');
    const spans=input.resourceSpans?.flatMap(r=>(r.scopeSpans??[]).flatMap(s=>(s.spans??[]).map(span=>({...span,...(r.resource?{resource:r.resource}:{}),...(s.scope?{scope:s.scope}:{})}))))??input.spans;
    if(!Array.isArray(spans)||!spans.length||spans.length>200)fail('Send OTLP JSON resourceSpans or 1–200 spans.');
    if(spans.some(s=>!s||s.attributes!==undefined&&(!Array.isArray(s.attributes)||s.attributes.length>64||s.attributes.some(a=>typeof a?.key!=='string'||a.key.length>128||!a.value||typeof a.value!=='object'))))fail('Span attributes must be bounded key/value arrays.');
    const checked=spans.map(s=>{if(!/^[a-f0-9]{32}$/i.test(s.traceId)||!/^([a-f0-9]{16})$/i.test(s.spanId)||s.parentSpanId&&!/^[a-f0-9]{16}$/i.test(s.parentSpanId)||typeof s.name!=='string'||s.name.length>256||JSON.stringify(s).length>12000||!/^[0-9]{1,20}$/.test(String(s.startTimeUnixNano))||!/^[0-9]{1,20}$/.test(String(s.endTimeUnixNano))||BigInt(s.endTimeUnixNano)<BigInt(s.startTimeUnixNano))fail('Invalid span IDs, timestamps, name or size.');return s;});
    this.runtime.transaction(()=>{for(const s of checked)this.db.prepare('INSERT INTO telemetry_spans VALUES (?,?,?,?,?) ON CONFLICT(tenant,environment,traceId,spanId) DO NOTHING').run(tenant,environment,s.traceId,s.spanId,JSON.stringify(s));});
    let recordedOutcomes=0;const warnings=[];
    for(const s of checked){const attrs=Object.fromEntries((s.attributes??[]).map(a=>[a.key,a.value?.stringValue??a.value?.doubleValue??a.value?.intValue??a.value?.boolValue]));if(!attrs['runtime.execution_id'])continue;try{const metrics={success:![2,'STATUS_CODE_ERROR'].includes(s.status?.code),latencyMs:Number(BigInt(s.endTimeUnixNano)-BigInt(s.startTimeUnixNano))/1e6};for(const [attribute,key]of Object.entries({'gen_ai.usage.input_tokens':'inputTokens','gen_ai.usage.output_tokens':'outputTokens','runtime.quality':'quality','runtime.cost_usd':'costUsd'}))if(attrs[attribute]!==undefined)metrics[key]=Number(attrs[attribute]);const result=this.runtime.outcome(tenant,environment,{traceId:attrs['runtime.execution_id'],metrics});if(!result.duplicate)recordedOutcomes++;}catch{warnings.push({spanId:s.spanId,reason:'Execution was not found in this scope, or metrics were invalid.'});}}
    return {accepted:checked.length,recordedOutcomes,warnings};
  }
  traces(tenant,environment){return this.db.prepare('SELECT document FROM telemetry_spans WHERE tenant=? AND environment=? ORDER BY rowid DESC LIMIT 200').all(tenant,environment).map(r=>JSON.parse(r.document));}
  collectNotifications(){this.db.exec("INSERT OR IGNORE INTO notifications SELECT id,tenant,environment,details,NULL FROM runtime_alerts");}
  notifications(tenant,environment){this.collectNotifications();return this.db.prepare('SELECT id,document,readAt FROM notifications WHERE tenant=? AND environment=? ORDER BY rowid DESC LIMIT 100').all(tenant,environment).map(r=>({id:r.id,...JSON.parse(r.document),readAt:r.readAt}));}
  acknowledge(tenant,environment,id){if(!this.db.prepare('UPDATE notifications SET readAt=? WHERE tenant=? AND environment=? AND id=?').run(now(),tenant,environment,id).changes)fail('Notification not found.','NOT_FOUND',404);return {read:true};}
  schedule(identity,environment,input){const doc=this.runtime.get(identity.tenant,environment,input.kind,input.key);const due=Date.parse(input.dueAt);if(!Number.isFinite(due)||due<=Date.now()||due>Date.now()+30*86400000||input.expectedVersion!==doc.version)fail('Supply a current version and a future date within 30 days.');const id=randomUUID();this.db.prepare('INSERT INTO scheduled_changes(id,tenant,environment,actor,kind,key,expectedVersion,document,dueAt,status,error) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id,identity.tenant,environment,identity.actor,input.kind,input.key,input.expectedVersion,JSON.stringify(input.document),new Date(due).toISOString(),environment==='production'?'pending_review':'pending',null);this.audit(identity,'release_scheduled',id,environment);return {id,status:environment==='production'?'pending_review':'pending'};}
  schedules(tenant,environment){return this.db.prepare('SELECT id,kind,key,actor,reviewer,dueAt,status,error FROM scheduled_changes WHERE tenant=? AND environment=? ORDER BY dueAt DESC LIMIT 100').all(tenant,environment);}
  runSchedules(){for(const row of this.db.prepare("SELECT * FROM scheduled_changes WHERE status='pending' AND dueAt<=?").all(now())){try{this.runtime.save(row.tenant,row.environment,row.reviewer??row.actor,row.kind,{...JSON.parse(row.document),key:row.key},row.expectedVersion,'scheduled_release');this.db.prepare("UPDATE scheduled_changes SET status='completed' WHERE id=?").run(row.id);}catch{this.db.prepare("UPDATE scheduled_changes SET status='failed',error='Resource changed or invalid release document.' WHERE id=?").run(row.id);}}}
  retention(identity,environment,{days,apply=false}){
    if(!Number.isInteger(days)||days<7||days>365)fail('Retention days must be 7–365.');
    const cutoff=Date.now()-days*86400000,date=new Date(cutoff).toISOString(),nano=(BigInt(cutoff)*1000000n).toString();
    const traceWhere="tenant=? AND environment=? AND CAST(json_extract(document,'$.endTimeUnixNano') AS INTEGER)<CAST(? AS INTEGER)";
    const jobWhere="tenant=? AND environment=? AND status IN ('completed','cancelled','failed') AND updatedAt<?";
    const counts={spans:this.db.prepare(`SELECT COUNT(*) AS n FROM telemetry_spans WHERE ${traceWhere}`).get(identity.tenant,environment,nano).n,jobs:this.db.prepare(`SELECT COUNT(*) AS n FROM evaluation_jobs WHERE ${jobWhere}`).get(identity.tenant,environment,date).n};
    if(apply)this.runtime.transaction(()=>{this.db.prepare(`DELETE FROM telemetry_spans WHERE ${traceWhere}`).run(identity.tenant,environment,nano);this.db.prepare(`DELETE FROM evaluation_jobs WHERE ${jobWhere}`).run(identity.tenant,environment,date);this.audit(identity,'retention_applied',`days-${days}`,environment);});
    return {cutoff:date,...counts,applied:apply};
  }
  reviewSchedule(identity,environment,id,decision){const row=this.db.prepare('SELECT * FROM scheduled_changes WHERE id=? AND tenant=? AND environment=?').get(id,identity.tenant,environment);if(!row)fail('Schedule not found.','NOT_FOUND',404);if(row.status!=='pending_review')fail('This schedule is not awaiting review.','SCHEDULE_STATE',409);if(row.actor===identity.actor)fail('A different reviewer must approve this schedule.','SELF_APPROVAL',403);if(!['approve','reject'].includes(decision))fail('Choose approve or reject.');const status=decision==='approve'?'pending':'rejected';this.db.prepare("UPDATE scheduled_changes SET status=?,reviewer=? WHERE id=? AND status='pending_review'").run(status,identity.actor,id);this.audit(identity,`schedule_${decision}`,id,environment);return {id,status};}
  cancelSchedule(identity,environment,id){if(!this.db.prepare("UPDATE scheduled_changes SET status='cancelled' WHERE tenant=? AND environment=? AND id=? AND status IN ('pending','pending_review')").run(identity.tenant,environment,id).changes)fail('Schedule is missing or already closed.','SCHEDULE_STATE',409);this.audit(identity,'schedule_cancelled',id,environment);return {id,status:'cancelled'};}
}





