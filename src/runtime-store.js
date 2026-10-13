import { EnterprisePolicies } from './enterprise-policies.js';
import { createHash, randomUUID, generateKeyPairSync, sign } from 'node:crypto';
import { validateResource, matches, customize, scoreJudge, fail } from './runtime-schema.js';
import {experimentAnalysis} from './analysis.js';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bucket = value => parseInt(hash(value).slice(0,8),16) / 4294967296;
const now = () => new Date().toISOString();
const mean = values => values.length ? values.reduce((s,v) => s+v,0)/values.length : null;

export class RuntimeStore {
  constructor(store) {
    this.db = store.db;
    this.signing = generateKeyPairSync('ed25519');
    this.db.exec(`CREATE TABLE IF NOT EXISTS runtime_resources (tenant TEXT, environment TEXT, kind TEXT, key TEXT, version INTEGER, document TEXT NOT NULL, PRIMARY KEY(tenant,environment,kind,key,version));
      CREATE TABLE IF NOT EXISTS runtime_executions (id TEXT PRIMARY KEY, tenant TEXT, environment TEXT, key TEXT, version INTEGER, variation TEXT, createdAt TEXT, outcome TEXT, config TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runtime_assignments (tenant TEXT, environment TEXT, key TEXT, version INTEGER, subject TEXT, variation TEXT, PRIMARY KEY(tenant,environment,key,version,subject));
      CREATE TABLE IF NOT EXISTS runtime_alerts (id TEXT PRIMARY KEY, tenant TEXT, environment TEXT, key TEXT, version INTEGER, timestamp TEXT, details TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runtime_evals (id TEXT PRIMARY KEY, tenant TEXT, environment TEXT, timestamp TEXT, result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runtime_rollouts (tenant TEXT, environment TEXT, key TEXT, version INTEGER, step INTEGER, startedAt TEXT, PRIMARY KEY(tenant,environment,key,version));
      CREATE TABLE IF NOT EXISTS runtime_graph_runs (id TEXT PRIMARY KEY, tenant TEXT, environment TEXT, key TEXT, snapshot TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runtime_approvals (id TEXT PRIMARY KEY, tenant TEXT, environment TEXT, actor TEXT, kind TEXT, key TEXT, expectedVersion INTEGER, document TEXT, status TEXT, reviewer TEXT, timestamp TEXT);
      CREATE TABLE IF NOT EXISTS runtime_playgrounds (id TEXT PRIMARY KEY, tenant TEXT, environment TEXT, timestamp TEXT, result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runtime_trigger_state(tenant TEXT,environment TEXT,key TEXT,version INTEGER,firstBreach INTEGER,lastAction INTEGER,PRIMARY KEY(tenant,environment,key,version));
      CREATE TRIGGER IF NOT EXISTS immutable_runtime_versions BEFORE UPDATE ON runtime_resources BEGIN SELECT RAISE(ABORT,'Immutable resource versions'); END;`);
    this.policies=new EnterprisePolicies(this);
  }
  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; } catch(error) { this.db.exec('ROLLBACK'); throw error; }
  }
  get(tenant, environment, kind, key, version) {
    const row = version === undefined
      ? this.db.prepare('SELECT document FROM runtime_resources WHERE tenant=? AND environment=? AND kind=? AND key=? ORDER BY version DESC LIMIT 1').get(tenant,environment,kind,key)
      : this.db.prepare('SELECT document FROM runtime_resources WHERE tenant=? AND environment=? AND kind=? AND key=? AND version=?').get(tenant,environment,kind,key,version);
    if(!row) fail('Resource not found in this workspace and environment.', 'NOT_FOUND',404);
    return JSON.parse(row.document);
  }
  list(tenant, environment, kind) {
    return this.db.prepare('SELECT document FROM runtime_resources r WHERE tenant=? AND environment=? AND kind=? AND version=(SELECT MAX(version) FROM runtime_resources WHERE tenant=r.tenant AND environment=r.environment AND kind=r.kind AND key=r.key) ORDER BY key').all(tenant,environment,kind).map(r => JSON.parse(r.document));
  }
  history(tenant,environment,kind,key) { return this.db.prepare('SELECT document FROM runtime_resources WHERE tenant=? AND environment=? AND kind=? AND key=? ORDER BY version DESC').all(tenant,environment,kind,key).map(r => JSON.parse(r.document)); }
  save(tenant,environment,actor,kind,input,expectedVersion,action='runtime_save') {
    return this.transaction(() => this.insert(tenant,environment,actor,kind,input,expectedVersion,action));
  }
  insert(tenant,environment,actor,kind,input,expectedVersion,action) {
    const normalized=structuredClone(input);
    if(kind==='configs' && Array.isArray(normalized.variations)) for(const variation of normalized.variations) {
      if(!variation || typeof variation!=='object' || Array.isArray(variation))fail('Each variation must be an object.');
      const snippet=ref=>{
        if(!ref||typeof ref!=='object'||Array.isArray(ref)||typeof ref.key!=='string'||ref.version!==undefined&&(!Number.isInteger(ref.version)||ref.version<1))fail('Snippet references require a key and optional positive version.');
        const value=this.get(tenant,environment,'snippets',ref.key,ref.version);
        return {content:value.content,ref:{key:value.key,version:value.version}};
      };
      if(variation.instructionsRef){const value=snippet(variation.instructionsRef);variation.instructions=value.content;variation.instructionsRef=value.ref;}
      if(Array.isArray(variation.messages))for(const message of variation.messages){if(message?.snippetRef){const value=snippet(message.snippetRef);message.content=value.content;message.snippetRef=value.ref;}}
      if(variation.modelRef) {
        const model=this.get(tenant,environment,'models',variation.modelRef,variation.modelVersion);
        variation.provider=model.provider;variation.model=model.model;variation.parameters={...(model.parameters ?? {}),...(variation.parameters ?? {})};variation.modelVersion=model.version;
      }
      if(variation.tools!==undefined && !Array.isArray(variation.tools))fail('Tools must be an array of registered tool keys.');
      if(variation.tools?.length) variation.toolDefinitions=variation.tools.map(key=>this.get(tenant,environment,'tools',key,variation.toolDefinitions?.find(t=>t.key===key)?.version));
    }
    const document = validateResource(kind,normalized);
    if(kind==='configs')this.policies?.enforce(tenant,environment,document,{allowDisabled:true});
    if(kind==='configs')for(const rule of document.rules??[])if(rule.segment)rule.segmentDefinition=this.get(tenant,environment,'segments',rule.segment,rule.segmentDefinition?.version);else delete rule.segmentDefinition;
    const previous = this.db.prepare('SELECT MAX(version) AS version FROM runtime_resources WHERE tenant=? AND environment=? AND kind=? AND key=?').get(tenant,environment,kind,document.key).version ?? 0;
    if (expectedVersion !== previous) fail('Resource changed. Reload before saving.', 'VERSION_CONFLICT',409);
    if(kind === 'configs') {
      if(document.judge) this.get(tenant,environment,'judges',document.judge);
      for(const judge of document.judges??[])this.get(tenant,environment,'judges',judge);
      if(document.guard?.rollbackVersion) {
        if(document.guard.rollbackVersion > previous) fail('Rollback must reference an existing earlier version.');
        this.get(tenant,environment,'configs',document.key,document.guard.rollbackVersion);
      }
    }
    if(kind === 'graphs') for(const node of document.nodes) {
      if(this.get(tenant,environment,'configs',node.config).mode !== 'agent') fail('Graph nodes must reference agent-mode configurations.');
    }
    const result = { ...document, version: previous+1, updatedAt: now() };
    this.db.prepare('INSERT INTO runtime_resources VALUES (?,?,?,?,?,?)').run(tenant,environment,kind,result.key,result.version,JSON.stringify(result));
    this.db.prepare('INSERT INTO audit VALUES (?,?,?,?,?,?,?,?)').run(randomUUID(),tenant,actor,action,environment,`${kind}/${result.key}`,result.version,result.updatedAt);
    if(kind === 'configs' && result.progressive) this.db.prepare('INSERT INTO runtime_rollouts VALUES (?,?,?,?,?,?)').run(tenant,environment,result.key,result.version,0,result.updatedAt);
    return result;
  }
  restore(tenant,environment,actor,kind,key,input) {
    const original = this.get(tenant,environment,kind,key,input.version);
    if(kind === 'configs') { delete original.guard; delete original.trigger; delete original.progressive; delete original.experiment; }
    return this.save(tenant,environment,actor,kind,original,input.expectedVersion,'runtime_restore');
  }
  choose(tenant,environment,config,context) {
    if(!context || typeof context.userId !== 'string' || !context.userId.length || context.userId.length > 128) fail('Supply a stable userId of at most 128 characters.', 'INVALID_CONTEXT');
    if(context.attributes !== undefined && (!context.attributes || typeof context.attributes !== 'object' || Array.isArray(context.attributes))) fail('Attributes must be an object.', 'INVALID_CONTEXT');
    let variation = config.defaultVariation, reason = 'disabled';
    if(config.enabled) {
      const rule = (config.rules ?? []).find(rule => matches(rule,context));
      if(rule) { variation = rule.variation; reason = 'targeted'; }
      else if(config.experiment?.holdoutPercent&&bucket([tenant,environment,config.key,context.userId,'holdout'])*100<config.experiment.holdoutPercent){variation=config.defaultVariation;reason='holdout';}
      else if(config.progressive) {
        const state = this.db.prepare('SELECT * FROM runtime_rollouts WHERE tenant=? AND environment=? AND key=? AND version=?').get(tenant,environment,config.key,config.version);
        const percentage = config.progressive.steps[state?.step ?? 0];
        variation = bucket([tenant,environment,config.key,context.userId,'ramp']) * 100 < percentage ? config.progressive.variation : config.defaultVariation;
        reason = 'progressive';
      } else if(config.experiment?.mode === 'bandit') {
        const subject = hash([tenant,environment,context.userId]);
        const assigned = this.db.prepare('SELECT variation FROM runtime_assignments WHERE tenant=? AND environment=? AND key=? AND version=? AND subject=?').get(tenant,environment,config.key,config.version,subject);
        if(assigned) variation = assigned.variation;
        else {
          const active = config.variations.filter(v => v.weight > 0);
          const summaries = this.metrics(tenant,environment,config.key,config.version);
          const unexplored = active.find(v => !summaries.find(s => s.variation === v.id)?.rewardSamples);
          const exploration = bucket([tenant,environment,config.key,config.version,context.userId,'explore']) < (config.experiment.epsilon ?? .1);
          variation = unexplored?.id ?? (exploration ? active[Math.floor(bucket([subject,config.key,'arm']) * active.length)].id : active.toSorted((a,b) => (summaries.find(s => s.variation === b.id)?.reward ?? 0) - (summaries.find(s => s.variation === a.id)?.reward ?? 0))[0].id);
          this.db.prepare('INSERT INTO runtime_assignments VALUES (?,?,?,?,?,?)').run(tenant,environment,config.key,config.version,subject,variation);
        }
        reason = 'bandit';
      } else {
        const assignment = bucket([tenant,environment,config.key,context.userId,'ab']) * 100;
        let cumulative = 0;
        for(const candidate of config.variations) { cumulative += candidate.weight; if(assignment < cumulative) { variation = candidate.id; break; } }
        reason = config.experiment ? 'experiment' : 'weighted';
      }
    }
    return { variation, reason };
  }
  resolve(tenant,environment,key,input,{ override, graphTraceId } = {}) {
    const config = this.get(tenant,environment,'configs',key);
    this.policies.enforce(tenant,environment,config);
    const choice = this.choose(tenant,environment,config,input.context);
    if(override) { if(!config.variations.some(v => v.id === override)) fail('Unknown variation.'); choice.variation=override; choice.reason='explicit'; }
    const variation = customize(config.variations.find(v => v.id === choice.variation),input.variables ?? {});
    const judge = config.judge ? this.get(tenant,environment,'judges',config.judge) : null;
    const judges=(config.judges??(config.judge?[config.judge]:[])).map(key=>this.get(tenant,environment,'judges',key));
    const result = { key, environment, version: config.version, ...choice, configuration: variation, mode: config.mode, judge, sampled: bucket([tenant,environment,key,input.context.userId,'sample']) < (config.sampleRate ?? 1), retry: config.retry ?? null, traceId: randomUUID(), graphTraceId: graphTraceId ?? null, timestamp: now() };
    result.judges=judges;
    // Persist immutable configuration and judge references with each execution.
    this.db.prepare('INSERT INTO runtime_executions VALUES (?,?,?,?,?,?,?,?,?)').run(result.traceId,tenant,environment,key,config.version,choice.variation,result.timestamp,null,JSON.stringify({ config, judge, judges, reason:choice.reason, subject:hash([tenant,environment,input.context.userId]), sampled:result.sampled, graphTraceId:result.graphTraceId }));
    return result;
  }
  execution(tenant,environment,id) {
    const row = this.db.prepare('SELECT * FROM runtime_executions WHERE tenant=? AND environment=? AND id=?').get(tenant,environment,id);
    if(!row) fail('Execution not found.', 'NOT_FOUND',404);
    return row;
  }
  retry(tenant,environment,key,input) {
    const original=this.execution(tenant,environment,input.traceId);
    if(original.key!==key) fail('Retry trace does not belong to this config.');
    const {config,judge,judges,subject,sampled,graphTraceId}=JSON.parse(original.config);
    this.policies?.enforce(tenant,environment,config);
    if(!config.retry || original.variation===config.retry.variation) fail('No further retry is permitted.', 'RETRY_NOT_ALLOWED');
    if(this.db.prepare("SELECT id FROM runtime_executions WHERE tenant=? AND environment=? AND json_extract(config,'$.parentTraceId')=? LIMIT 1").get(tenant,environment,original.id))fail('A retry has already been issued for this attempt.','RETRY_NOT_ALLOWED');
    if(!original.outcome) fail('Record the first attempt before requesting a retry.');
    const prior=JSON.parse(original.outcome).metrics;
    if(prior.success && (prior.quality===undefined || prior.quality>=config.retry.minQuality)) fail('First attempt does not meet the retry conditions.','RETRY_NOT_ALLOWED');
    const latest=this.get(tenant,environment,'configs',key);
    if(!latest.enabled || latest.version!==config.version) fail('Configuration changed. Resolve it again before retrying.','VERSION_CONFLICT',409);
    const variation=customize(config.variations.find(v=>v.id===config.retry.variation),input.variables ?? {});
    const result={key,environment,version:config.version,variation:variation.id,configuration:variation,mode:config.mode,judge,judges,sampled,retry:null,traceId:randomUUID(),parentTraceId:original.id,graphTraceId,timestamp:now(),reason:'retry'};
    this.db.prepare('INSERT INTO runtime_executions VALUES (?,?,?,?,?,?,?,?,?)').run(result.traceId,tenant,environment,key,config.version,variation.id,result.timestamp,null,JSON.stringify({config,judge,judges,subject,sampled,graphTraceId,parentTraceId:original.id}));
    return result;
  }
  outcome(tenant,environment,input) {
    return this.transaction(() => {
      const execution = this.execution(tenant,environment,input.traceId);
      const { config, judge, sampled } = JSON.parse(execution.config);
      const attached=JSON.parse(execution.config).judges??(judge?[judge]:[]);
      if(execution.outcome) return { duplicate:true, traceId:execution.id };
      const data = input.metrics;
      if(!data || typeof data !== 'object' || typeof data.success !== 'boolean') fail('Metrics require a Boolean success value.');
      for(const metric of ['latencyMs','costUsd','inputTokens','outputTokens','firstTokenMs']) if(data[metric] !== undefined && (!Number.isFinite(data[metric]) || data[metric]<0 || data[metric]>1e9)) fail(`${metric} must be a bounded nonnegative number.`);
      for(const metric of ['quality','reward','satisfaction']) if(data[metric] !== undefined && (!Number.isFinite(data[metric]) || data[metric]<0 || data[metric]>1)) fail(`${metric} must be between 0 and 1.`);
      let evaluation = null;
      const evaluations=[];
      if(sampled&&input.output!==undefined&&attached.length&&(!judge||config.judges)) {
        if(typeof input.output!=='string'||input.output.length>16000)fail('Evaluation output must be bounded text.');
        for(const j of attached){const supplied=input.judgements?.[j.key];const score=j.type==='llm'?supplied:scoreJudge(j,input.input??'',input.output,input.expected);if(!score||!Number.isFinite(score.score)||score.score<0||score.score>1||typeof score.reason!=='string'||score.reason.length>2000)fail(`Supply a valid judgement for ${j.key}.`);evaluations.push({...score,judge:j.key,judgeVersion:j.version});}
        evaluation={score:mean(evaluations.map(e=>e.score)),reason:'Mean of attached judges',source:'multi-judge'};
      }
      if(!config.judges&&judge && sampled && input.output !== undefined) {
        if(typeof input.output !== 'string' || input.output.length > 16000) fail('Evaluation output must be text of at most 16000 characters.');
        if(judge.type === 'llm') {
          if(!input.judgement || !Number.isFinite(input.judgement.score) || input.judgement.score < 0 || input.judgement.score > 1 || typeof input.judgement.reason !== 'string' || input.judgement.reason.length > 2000) fail('LLM judgement requires a score of 0–1 and reason.');
          evaluation = { ...input.judgement, source:'application-llm-judge', judge:judge.key, judgeVersion:judge.version };
        } else evaluation = { ...scoreJudge(judge,input.input ?? '',input.output,input.expected), judge:judge.key, judgeVersion:judge.version };
      }
      const metrics = { success:data.success, ...Object.fromEntries(['latencyMs','costUsd','inputTokens','outputTokens','firstTokenMs','reward','satisfaction'].filter(k=>data[k]!==undefined).map(k=>[k,data[k]])), ...(evaluation ? {quality:evaluation.score} : data.quality !== undefined ? {quality:data.quality}:{}) };
      const outcome = { metrics,evaluation,evaluations,timestamp:now() };
      this.db.prepare('UPDATE runtime_executions SET outcome=? WHERE id=? AND tenant=? AND environment=? AND outcome IS NULL').run(JSON.stringify(outcome),execution.id,tenant,environment);
      const latest = this.get(tenant,environment,'configs',execution.key);
      let automation = null;
      if(latest.enabled && latest.version === execution.version) automation = this.automate(tenant,environment,latest);
      return { traceId:execution.id,metrics,evaluation,automation };
    });
  }
  outcomes(tenant,environment,key,version,windowSeconds) {
    const records = this.db.prepare('SELECT * FROM runtime_executions WHERE tenant=? AND environment=? AND key=? AND version=? AND outcome IS NOT NULL').all(tenant,environment,key,version);
    const since = windowSeconds ? Date.now()-windowSeconds*1000 : 0;
    return records.map(r => ({...r,subject:JSON.parse(r.config).subject,reason:JSON.parse(r.config).reason,...JSON.parse(r.outcome)})).filter(r => Date.parse(r.timestamp)>=since);
  }
  summary(records) {
    const values = metric => records.map(r => r.metrics[metric]).filter(v => typeof v === 'number');
    return { samples:records.length,qualitySamples:values('quality').length,rewardSamples:values('reward').length,latencySamples:values('latencyMs').length,costSamples:values('costUsd').length,errorRate:records.length ? records.filter(r => !r.metrics.success).length/records.length : null,quality:mean(values('quality')),reward:mean(values('reward')),latencyMs:mean(values('latencyMs')),costUsd:mean(values('costUsd')),totalCostUsd:values('costUsd').length?values('costUsd').reduce((s,v)=>s+v,0):null,inputTokens:values('inputTokens').length?values('inputTokens').reduce((s,v)=>s+v,0):null,outputTokens:values('outputTokens').length?values('outputTokens').reduce((s,v)=>s+v,0):null,firstTokenMs:mean(values('firstTokenMs')),satisfaction:mean(values('satisfaction')) };
  }
  metrics(tenant,environment,key,version) {
    const config = this.get(tenant,environment,'configs',key,version);
    const records = this.outcomes(tenant,environment,key,config.version);
    return config.variations.map(v => ({ variation:v.id,version:config.version,...this.summary(records.filter(r => r.variation===v.id)) }));
  }
  automate(tenant,environment,config) {
    if(config.experiment?.autoPromote){
      const exposures=this.db.prepare('SELECT variation,config FROM runtime_executions WHERE tenant=? AND environment=? AND key=? AND version=?').all(tenant,environment,config.key,config.version).map(row=>({...row,subject:JSON.parse(row.config).subject,reason:JSON.parse(row.config).reason}));
      const analysis=experimentAnalysis(config,this.outcomes(tenant,environment,config.key,config.version),exposures);
      if(analysis.winner){
        const next=structuredClone(config);delete next.experiment;
        next.defaultVariation=analysis.winner;next.variations=next.variations.map(v=>({...v,weight:v.id===analysis.winner?100:0}));
        const details={action:'promote',reason:`Conclusive ${analysis.metric} experiment winner: ${analysis.winner}`,fromVersion:config.version,winner:analysis.winner};
        if(environment==='production'&&this.requireProductionApproval){
          const prior=this.db.prepare("SELECT id FROM runtime_approvals WHERE tenant=? AND environment=? AND kind='configs' AND key=? AND expectedVersion=? AND actor='experiment-automation' ORDER BY rowid DESC LIMIT 1").get(tenant,environment,config.key,config.version);
          if(prior)return null;
          const request=this.requestApproval(tenant,environment,'experiment-automation','configs',next,config.version);
          details.action='promotion_review';details.approval=request.id;
        }else details.toVersion=this.insert(tenant,environment,'experiment-automation','configs',next,config.version,'automatic_experiment_promotion').version;
        this.db.prepare('INSERT INTO runtime_alerts VALUES (?,?,?,?,?,?,?)').run(randomUUID(),tenant,environment,config.key,config.version,now(),JSON.stringify(details));return details;
      }
    }
    const guard = config.guard, trigger=config.trigger;
    let reason, action;
    if(guard) {
      const records = this.outcomes(tenant,environment,config.key,config.version,guard.windowSeconds).filter(r => !config.progressive || r.variation === config.progressive.variation);
      const metrics = this.summary(records);
      if(metrics.samples>=guard.minSamples) {
        const failures=[];
        if(guard.minQuality!==undefined && metrics.qualitySamples>=guard.minSamples && metrics.quality<guard.minQuality) failures.push('quality');
        if(guard.maxLatencyMs!==undefined && metrics.latencySamples>=guard.minSamples && metrics.latencyMs>guard.maxLatencyMs) failures.push('latency');
        if(guard.maxCostUsd!==undefined && metrics.costSamples>=guard.minSamples && metrics.costUsd>guard.maxCostUsd) failures.push('cost');
        if(guard.maxErrorRate!==undefined && metrics.errorRate>guard.maxErrorRate) failures.push('error rate');
        if(failures.length) {reason=`Guard thresholds breached: ${failures.join(', ')}`; action=guard.action;}
      }
      if(!reason&&guard.statistical){const s=guard.statistical;const all=this.outcomes(tenant,environment,config.key,config.version);const analysis=experimentAnalysis({...config,experiment:{metric:s.metric,baseline:s.baseline,alpha:s.alpha??.05,minSamples:guard.minSamples}},all);const diff=analysis.comparisons.find(c=>c.variation===s.candidate);const sampled=analysis.arms.filter(a=>[s.baseline,s.candidate].includes(a.variation));if(sampled.length===2&&sampled.every(a=>a.samples>=guard.minSamples)&&diff&&(s.metric==='errorRate'?diff.lower>(s.tolerance??0):diff.upper<-(s.tolerance??0))){reason='Statistical regression against control';action=guard.action;}}
      if(!reason&&guard.maxWaitSeconds&&Date.now()-Date.parse(config.updatedAt)>guard.maxWaitSeconds*1000&&metrics.samples<guard.minSamples){reason='Insufficient samples before guard deadline';action=guard.action;}
    }
    if(!reason && trigger) {
      const metrics=this.summary(this.outcomes(tenant,environment,config.key,config.version,trigger.windowSeconds));
      const count=trigger.metric==='quality' ? metrics.qualitySamples : trigger.metric==='latencyMs'?metrics.latencySamples:trigger.metric==='costUsd'?metrics.costSamples:metrics.samples;
      const breached=count>=trigger.minSamples && (trigger.metric==='quality' ? metrics.quality<trigger.threshold : metrics[trigger.metric]>trigger.threshold);
      const state=this.db.prepare('SELECT * FROM runtime_trigger_state WHERE tenant=? AND environment=? AND key=? AND version=?').get(tenant,environment,config.key,config.version);
      if(!breached)this.db.prepare('UPDATE runtime_trigger_state SET firstBreach=NULL WHERE tenant=? AND environment=? AND key=? AND version=?').run(tenant,environment,config.key,config.version);
      else {const first=state?.firstBreach??Date.now();if(!state?.firstBreach)this.db.prepare('INSERT INTO runtime_trigger_state VALUES (?,?,?,?,?,?) ON CONFLICT(tenant,environment,key,version) DO UPDATE SET firstBreach=excluded.firstBreach').run(tenant,environment,config.key,config.version,first,null);if(Date.now()-first>=(trigger.delaySeconds??0)*1000&&Date.now()-(this.db.prepare('SELECT MAX(lastAction) AS time FROM runtime_trigger_state WHERE tenant=? AND environment=? AND key=?').get(tenant,environment,config.key).time??0)>=(trigger.cooldownSeconds??0)*1000 && (config.defaultVariation!==trigger.variation||config.variations.some(v=>v.id!==trigger.variation&&v.weight>0)||(config.rules??[]).length)){reason=`Adaptive trigger: ${trigger.metric} crossed threshold`;action='switch';}}
    }
    if(reason) {
      let next = action==='rollback' ? this.get(tenant,environment,'configs',config.key,guard.rollbackVersion) : {...config};
      if(action==='pause') next.enabled=false;
      if(action==='switch') {next.defaultVariation=trigger.variation; next.variations=next.variations.map(v=>({...v,weight:v.id===trigger.variation?100:0}));next.rules=[];}
      delete next.guard;if(action!=='switch'||!trigger?.repeat)delete next.trigger;delete next.progressive;delete next.experiment;
      if(action==='switch')this.db.prepare('UPDATE runtime_trigger_state SET lastAction=? WHERE tenant=? AND environment=? AND key=? AND version=?').run(Date.now(),tenant,environment,config.key,config.version);
      const saved=this.insert(tenant,environment,'system','configs',next,config.version,`automatic_${action}`);
      const details={action,reason,fromVersion:config.version,toVersion:saved.version};
      this.db.prepare('INSERT INTO runtime_alerts VALUES (?,?,?,?,?,?,?)').run(randomUUID(),tenant,environment,config.key,config.version,now(),JSON.stringify(details));
      return details;
    }
    if(config.progressive) {
      const state=this.db.prepare('SELECT * FROM runtime_rollouts WHERE tenant=? AND environment=? AND key=? AND version=?').get(tenant,environment,config.key,config.version);
      const p=config.progressive;
      const records=this.outcomes(tenant,environment,config.key,config.version).filter(r=>r.variation===p.variation && Date.parse(r.timestamp)>=Date.parse(state.startedAt));
      if(state.step<p.steps.length-1 && records.length>=p.minSamples && Date.now()-Date.parse(state.startedAt)>=p.intervalSeconds*1000) {
        this.db.prepare('UPDATE runtime_rollouts SET step=?,startedAt=? WHERE tenant=? AND environment=? AND key=? AND version=?').run(state.step+1,now(),tenant,environment,config.key,config.version);
        return {action:'advance',rollout:p.steps[state.step+1]};
      }
    }
    return null;
  }
  overview(tenant,environment) {
    const configurations=this.list(tenant,environment,'configs');
    return { configurations:configurations.map(c=>({key:c.key,version:c.version,enabled:c.enabled,mode:c.mode,experiment:c.experiment?.mode ?? null,metrics:this.metrics(tenant,environment,c.key,c.version),rollout:this.db.prepare('SELECT step,startedAt FROM runtime_rollouts WHERE tenant=? AND environment=? AND key=? AND version=?').get(tenant,environment,c.key,c.version) ?? null})),alerts:this.db.prepare('SELECT * FROM runtime_alerts WHERE tenant=? AND environment=? ORDER BY timestamp DESC LIMIT 100').all(tenant,environment).map(({tenant:ignored,details,...r})=>({...r,...JSON.parse(details)})),executions:this.db.prepare('SELECT id,key,version,variation,createdAt,outcome FROM runtime_executions WHERE tenant=? AND environment=? ORDER BY createdAt DESC LIMIT 100').all(tenant,environment).map(r=>({...r,outcome:r.outcome ? JSON.parse(r.outcome):null})),evaluations:this.db.prepare('SELECT result FROM runtime_evals WHERE tenant=? AND environment=? ORDER BY timestamp DESC LIMIT 30').all(tenant,environment).map(r=>JSON.parse(r.result)) };
  }
  savePlayground(tenant,environment,result) {
    this.db.prepare('INSERT INTO runtime_playgrounds VALUES (?,?,?,?,?)').run(result.id,tenant,environment,result.timestamp,JSON.stringify(result));return result;
  }
  playgroundHistory(tenant,environment) {return this.db.prepare('SELECT result FROM runtime_playgrounds WHERE tenant=? AND environment=? ORDER BY timestamp DESC LIMIT 30').all(tenant,environment).map(row=>JSON.parse(row.result));}
  benchmark(tenant,environment,input) {
    const dataset=this.get(tenant,environment,'datasets',input.dataset,input.datasetVersion);
    const config=this.get(tenant,environment,'configs',input.config,input.configVersion);
    this.policies.enforce(tenant,environment,config);
    const judge=this.get(tenant,environment,'judges',input.judge,input.judgeVersion);
    if(!Array.isArray(input.outputs) || input.outputs.length>1000 || !input.outputs.length) fail('Supply generated outputs for the dataset.');
    const seen=new Set();
    const rows=input.outputs.map(item=>{
      const row=dataset.rows.find(r=>r.id===item.rowId);
      if(!row || !config.variations.some(v=>v.id===item.variation) || typeof item.output!=='string' || item.output.length>16000) fail('Each output must identify a dataset row, config variation, and bounded text.');
      const key=JSON.stringify([item.rowId,item.variation]); if(seen.has(key)) fail('Duplicate row/variation output.');seen.add(key);
      const evaluation=judge.type==='llm' ? item.judgement : scoreJudge(judge,row.input,item.output,row.expected);
      if(!evaluation || !Number.isFinite(evaluation.score) || evaluation.score<0 || evaluation.score>1 || typeof evaluation.reason!=='string' || evaluation.reason.length>2000) fail('Judge result needs a score and reason.');
      return {rowId:row.id,variation:item.variation,score:evaluation.score,reason:evaluation.reason};
    });
    const variants=[...new Set(rows.map(r=>r.variation))];
    if(variants.some(v=>rows.filter(r=>r.variation===v).length!==dataset.rows.length)) fail('Every selected variation must cover every dataset row.');
    const result={id:randomUUID(),timestamp:now(),config:config.key,configVersion:config.version,dataset:dataset.key,datasetVersion:dataset.version,judge:judge.key,judgeVersion:judge.version,source:judge.type==='llm'?'application-llm-judge':'deterministic',summaries:variants.map(v=>({variation:v,rows:dataset.rows.length,meanScore:mean(rows.filter(r=>r.variation===v).map(r=>r.score))})),rows};
    const tags=[...new Set(dataset.rows.flatMap(r=>r.tags??[]))];result.slices=tags.flatMap(tag=>variants.map(variation=>{const ids=new Set(dataset.rows.filter(r=>r.tags?.includes(tag)).map(r=>r.id));const scores=rows.filter(r=>r.variation===variation&&ids.has(r.rowId)).map(r=>r.score);return {tag,variation,rows:scores.length,meanScore:mean(scores)};}));
    this.db.prepare('INSERT INTO runtime_evals VALUES (?,?,?,?,?)').run(result.id,tenant,environment,result.timestamp,JSON.stringify(result));
    return result;
  }
  graph(tenant,environment,key,input) {
    const graph=this.get(tenant,environment,'graphs',key);
    const traceId=randomUUID();
    const nodes=graph.nodes.map(node=>({ ...node,resolved:this.resolve(tenant,environment,node.config,input,{graphTraceId:traceId}) }));
    const result={...graph,traceId,nodes};
    this.db.prepare('INSERT INTO runtime_graph_runs VALUES (?,?,?,?,?)').run(traceId,tenant,environment,key,JSON.stringify(result));
    return result;
  }
  visit(tenant,environment,key,input) {
    const row=this.db.prepare('SELECT snapshot FROM runtime_graph_runs WHERE id=? AND tenant=? AND environment=? AND key=?').get(input.graphTraceId,tenant,environment,key);
    if(!row) fail('Graph execution not found.','NOT_FOUND',404);
    const graph=JSON.parse(row.snapshot),node=graph.nodes.find(n=>n.id===input.nodeId);
    if(!node) fail('Node is not a member of this graph.');
    const original=this.execution(tenant,environment,node.resolved.traceId);
    const snapshot=JSON.parse(original.config);
    const config=this.get(tenant,environment,'configs',node.config);
    if(!config.enabled) fail('Graph node configuration has been stopped.','CONFIG_STOPPED',409);
    const result={...node.resolved,traceId:randomUUID(),timestamp:now()};
    this.db.prepare('INSERT INTO runtime_executions VALUES (?,?,?,?,?,?,?,?,?)').run(result.traceId,tenant,environment,result.key,result.version,result.variation,result.timestamp,null,JSON.stringify(snapshot));
    return result;
  }
  graphMetrics(tenant,environment,key) {
    const runs=this.db.prepare('SELECT id,snapshot FROM runtime_graph_runs WHERE tenant=? AND environment=? AND key=?').all(tenant,environment,key);
    const executions=this.db.prepare('SELECT * FROM runtime_executions WHERE tenant=? AND environment=? AND outcome IS NOT NULL').all(tenant,environment).map(r=>({...r,...JSON.parse(r.outcome),snapshot:JSON.parse(r.config)}));
    const ids=new Set(runs.map(r=>r.id));const records=executions.filter(r=>ids.has(r.snapshot.graphTraceId));
    return {key,runs:runs.length,...this.summary(records),nodes:[...new Set(records.map(r=>r.key))].map(config=>({config,...this.summary(records.filter(r=>r.key===config))}))};
  }
  insights(tenant,environment,{from,to,key}={}) {
    const end=to?Date.parse(to):Date.now(),start=from?Date.parse(from):end-7*86400000;
    if(!Number.isFinite(start)||!Number.isFinite(end)||start>end||end-start>90*86400000)fail('Select a valid date range of at most 90 days.');
    const rows=this.db.prepare('SELECT key,version,variation,outcome FROM runtime_executions WHERE tenant=? AND environment=? AND outcome IS NOT NULL').all(tenant,environment).map(r=>({...r,...JSON.parse(r.outcome)})).filter(r=>Date.parse(r.timestamp)>=start&&Date.parse(r.timestamp)<=end&&(!key||r.key===key));
    const periods=[...new Set(rows.map(r=>r.timestamp.slice(0,13)))].sort();
    const versions=[...new Set(rows.map(r=>JSON.stringify([r.key,r.version,r.variation])))];
    return {from:new Date(start).toISOString(),to:new Date(end).toISOString(),summary:this.summary(rows),timeline:periods.map(hour=>({hour:hour+':00:00Z',...this.summary(rows.filter(r=>r.timestamp.startsWith(hour)))})),variations:versions.map(id=>{const [key,version,variation]=JSON.parse(id);return{key,version,variation,...this.summary(rows.filter(r=>r.key===key&&r.version===version&&r.variation===variation))};})};
  }
  requestApproval(tenant,environment,actor,kind,input,expectedVersion) {
    if(!Number.isInteger(expectedVersion)||expectedVersion<0)fail('Supply expectedVersion 0 for a new resource, or its current version.');
    const document=validateResource(kind,input);
    const id=randomUUID();this.db.prepare('INSERT INTO runtime_approvals VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id,tenant,environment,actor,kind,document.key,expectedVersion,JSON.stringify(document),'pending',null,now());
    return {id,status:'pending',actor,kind,key:document.key,expectedVersion};
  }
  approvals(tenant,environment) {
    return this.db.prepare('SELECT id,actor,kind,key,expectedVersion,document,status,reviewer,timestamp FROM runtime_approvals WHERE tenant=? AND environment=? ORDER BY timestamp DESC').all(tenant,environment).map(r=>({...r,document:JSON.parse(r.document)}));
  }
  review(tenant,environment,actor,id,decision) {
    return this.transaction(()=>{
      const approval=this.db.prepare('SELECT * FROM runtime_approvals WHERE id=? AND tenant=? AND environment=?').get(id,tenant,environment);
      if(!approval)fail('Approval not found.','NOT_FOUND',404);
      if(approval.status!=='pending')fail('Approval has already been decided.','APPROVAL_CLOSED',409);
      if(approval.actor===actor)fail('A different reviewer must decide this request.','SELF_APPROVAL',403);
      if(!['approve','reject'].includes(decision))fail('Choose approve or reject.');
      const document=JSON.parse(approval.document);
      if(decision==='approve'&&document.libraryPromotions!==undefined){const promotions=document.libraryPromotions;if(approval.kind!=='configs'||!Array.isArray(promotions)||promotions.length>100||promotions.some(p=>!['models','tools','judges','segments','snippets'].includes(p.kind)||!Number.isInteger(p.expectedVersion)||p.expectedVersion<0))fail('Invalid library promotion bundle.');for(const p of promotions)this.insert(tenant,environment,actor,p.kind,p.document,p.expectedVersion,'approved_library_promotion');this.retargetDependencies(document,promotions);delete document.libraryPromotions;}
      const result=decision==='approve'?this.insert(tenant,environment,actor,approval.kind,document,approval.expectedVersion,'approved_change'):null;
      this.db.prepare('UPDATE runtime_approvals SET status=?,reviewer=? WHERE id=?').run(decision==='approve'?'approved':'rejected',actor,id);
      this.db.prepare('INSERT INTO audit VALUES (?,?,?,?,?,?,?,?)').run(randomUUID(),tenant,actor,`approval_${decision}`,environment,`${approval.kind}/${approval.key}`,result?.version ?? approval.expectedVersion,now());
      return {id,status:decision==='approve'?'approved':'rejected',resource:result};
    });
  }
  retargetDependencies(document,promotions){
    const mapped=(kind,key,version)=>promotions.find(p=>p.kind===kind&&p.document.key===key&&p.document.version===version)?.expectedVersion+1;
    for(const variation of document.variations){
      if(variation.modelRef){const version=mapped('models',variation.modelRef,variation.modelVersion);if(Number.isFinite(version))variation.modelVersion=version;}
      for(const tool of variation.toolDefinitions??[]){const version=mapped('tools',tool.key,tool.version);if(Number.isFinite(version))tool.version=version;}
      for(const ref of [variation.instructionsRef,...(variation.messages??[]).map(m=>m.snippetRef)].filter(Boolean)){const version=mapped('snippets',ref.key,ref.version);if(Number.isFinite(version))ref.version=version;}
    }
    for(const rule of document.rules??[])if(rule.segmentDefinition){const version=mapped('segments',rule.segment,rule.segmentDefinition.version);if(Number.isFinite(version))rule.segmentDefinition.version=version;}
  }
  snapshot(tenant,environment) {
    const payload=JSON.stringify({tenant,environment,issuedAt:Date.now(),expiresAt:Date.now()+60000,configs:this.list(tenant,environment,'configs')});
    return {payload,signature:sign(null,Buffer.from(payload),this.signing.privateKey).toString('base64'),publicKey:this.signing.publicKey.export({type:'spki',format:'pem'})};
  }
}


