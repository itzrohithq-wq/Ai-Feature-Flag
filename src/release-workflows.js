import { randomUUID } from 'node:crypto';
import { fail } from './runtime-schema.js';
import { RuntimeClient } from './runtime-sdk.js';

export class ReleaseWorkflows {
  constructor(operations) {
    this.ops=operations;this.runtime=operations.runtime;this.db=operations.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS release_plans(id TEXT PRIMARY KEY,tenant TEXT,environment TEXT,actor TEXT,document TEXT,state TEXT);CREATE TABLE IF NOT EXISTS judge_calibrations(id TEXT PRIMARY KEY,tenant TEXT,environment TEXT,document TEXT);`);
  }
  plans(tenant,environment){return this.db.prepare('SELECT id,actor,document,state FROM release_plans WHERE tenant=? AND environment=? ORDER BY rowid DESC LIMIT 100').all(tenant,environment).map(row=>({id:row.id,actor:row.actor,...JSON.parse(row.document),...JSON.parse(row.state)}));}
  create(identity,environment,input){
    const config=this.runtime.get(identity.tenant,environment,'configs',input.config);
    if(!Array.isArray(input.stages)||!input.stages.length||input.stages.length>2||new Set(input.stages).size!==input.stages.length||input.stages.some(e=>!['staging','production'].includes(e))||input.stages.includes(environment)||input.stages.includes('production')&&input.stages.at(-1)!=='production')fail('Choose staging and/or production, in that order, outside the source environment.');
    if(!Number.isInteger(input.minSamples)||input.minSamples<2||input.minSamples>10000||!Number.isFinite(input.minQuality)||input.minQuality<0||input.minQuality>1)fail('Release gate needs 2–10000 samples and quality 0–1.');
    const dependencies=new Map(),add=(kind,key,version)=>{if(key){const document=this.runtime.get(identity.tenant,environment,kind,key,version);dependencies.set(`${kind}/${key}/${document.version}`,{kind,document});}};
    for(const variation of config.variations){add('models',variation.modelRef,variation.modelVersion);for(const tool of variation.toolDefinitions??[])add('tools',tool.key,tool.version);for(const ref of [variation.instructionsRef,...(variation.messages??[]).map(m=>m.snippetRef)].filter(Boolean))add('snippets',ref.key,ref.version);}
    for(const judge of config.judges??(config.judge?[config.judge]:[]))add('judges',judge);for(const rule of config.rules??[])add('segments',rule.segment,rule.segmentDefinition?.version);
    const id=randomUUID(),document={config:config.key,sourceVersion:config.version,configuration:config,dependencies:[...dependencies.values()],stages:input.stages,minSamples:input.minSamples,minQuality:input.minQuality,createdAt:new Date().toISOString()};
    this.db.prepare('INSERT INTO release_plans VALUES (?,?,?,?,?,?)').run(id,identity.tenant,environment,identity.actor,JSON.stringify(document),JSON.stringify({status:'ready',stage:0,deployments:[]}));this.ops.audit(identity,'release_plan_created',id,environment);return {id,status:'ready'};
  }
  advance(identity,environment,id){return this.runtime.transaction(()=>{
    const row=this.db.prepare('SELECT * FROM release_plans WHERE id=? AND tenant=? AND environment=?').get(id,identity.tenant,environment);if(!row)fail('Release plan not found.','NOT_FOUND',404);
    const plan=JSON.parse(row.document),state=JSON.parse(row.state),r=this.runtime;
    if(['completed','cancelled','rejected'].includes(state.status))fail('This release plan is closed.','PLAN_CLOSED',409);
    if(state.approval){const review=r.approvals(identity.tenant,'production').find(a=>a.id===state.approval);if(review?.status==='pending')fail('An independent reviewer must approve the production change first.','REVIEW_REQUIRED',409);if(review?.status!=='approved'){state.status='rejected';this.saveState(id,state);return {id,...state};}state.deployments.push({environment:'production',version:review.expectedVersion+1});state.stage++;delete state.approval;}
    const previous=state.deployments.at(-1);
    if(previous){const current=r.get(identity.tenant,previous.environment,'configs',plan.config);if(current.version!==previous.version)fail('Deployed configuration changed. Create a fresh release plan.','VERSION_CONFLICT',409);const evidence=r.outcomes(identity.tenant,previous.environment,plan.config,previous.version);const quality=evidence.map(e=>e.metrics.quality).filter(Number.isFinite);if(quality.length<plan.minSamples||quality.reduce((sum,value)=>sum+value,0)/quality.length<plan.minQuality)fail(`Release gate needs ${plan.minSamples} scored executions with mean quality at least ${plan.minQuality} in ${previous.environment}.`,'GATE_PENDING',409);}
    if(state.stage>=plan.stages.length){state.status='completed';this.saveState(id,state);return {id,...state};}
    const target=plan.stages[state.stage];
    if(identity.policy&&!identity.policy.environments.includes(target))fail('Credential cannot deploy to this environment.','SCOPE_FORBIDDEN',403);
    let expected=0;try{expected=r.get(identity.tenant,target,'configs',plan.config).version;}catch(error){if(error.status!==404)throw error;}
    const document=structuredClone(plan.configuration);delete document.version;delete document.updatedAt;
    const targetVersions=new Map();const libraryPromotions=(plan.dependencies??[]).map(dependency=>{const key=`${dependency.kind}/${dependency.document.key}`;let version=targetVersions.get(key);if(version===undefined){version=0;try{version=r.get(identity.tenant,target,dependency.kind,dependency.document.key).version;}catch(error){if(error.status!==404)throw error;}}targetVersions.set(key,version+1);return {...dependency,expectedVersion:version};});
    if(target==='production')document.libraryPromotions=libraryPromotions;else {for(const promotion of libraryPromotions)r.insert(identity.tenant,target,identity.actor,promotion.kind,promotion.document,promotion.expectedVersion,'release_plan_library');r.retargetDependencies(document,libraryPromotions);}
    if(target==='production'){const approval=r.requestApproval(identity.tenant,target,identity.actor,'configs',document,expected);state.approval=approval.id;state.status='awaiting_review';}
    else {const saved=r.insert(identity.tenant,target,identity.actor,'configs',document,expected,'release_plan_stage');state.deployments.push({environment:target,version:saved.version});state.stage++;state.status='awaiting_evidence';}
    this.saveState(id,state);this.ops.audit(identity,'release_plan_advanced',id,target);return {id,...state};
  });}
  saveState(id,state){this.db.prepare('UPDATE release_plans SET state=? WHERE id=?').run(JSON.stringify(state),id);}
  cancel(identity,environment,id){const row=this.db.prepare('SELECT state FROM release_plans WHERE id=? AND tenant=? AND environment=?').get(id,identity.tenant,environment);if(!row)fail('Plan not found.','NOT_FOUND',404);const state=JSON.parse(row.state);if(state.status==='completed')fail('Completed plans cannot be cancelled.');if(state.approval)this.db.prepare("UPDATE runtime_approvals SET status='rejected',reviewer=? WHERE id=? AND status='pending'").run(identity.actor,state.approval);state.status='cancelled';this.saveState(id,state);this.ops.audit(identity,'release_plan_cancelled',id,environment);return {id,...state};}
  calibrations(tenant,environment){return this.db.prepare('SELECT document FROM judge_calibrations WHERE tenant=? AND environment=? ORDER BY rowid DESC LIMIT 100').all(tenant,environment).map(row=>JSON.parse(row.document));}
  async calibrate(identity,environment,input){
    const judge=this.runtime.get(identity.tenant,environment,'judges',input.judge);
    if(!Array.isArray(input.rows)||input.rows.length<3||input.rows.length>100||input.rows.some(r=>typeof r.input!=='string'||typeof r.output!=='string'||r.input.length>8000||r.output.length>8000||!Number.isFinite(r.humanScore)||r.humanScore<0||r.humanScore>1))fail('Supply 3–100 labeled examples with input, output and humanScore 0–1.');
    if(judge.type==='llm'&&input.allowProviderCalls!==true)fail('Authorize LLM judge calls and usage charges.');
    const client=new RuntimeClient({baseUrl:'',token:'',providers:this.ops.providerSet(identity.tenant)}),rows=[];
    for(const row of input.rows){const result=await client.judge({judge,sampled:true},row.input,row.output,row.expected);rows.push({humanScore:row.humanScore,judgeScore:result.score,absoluteError:Math.abs(result.score-row.humanScore)});}
    const mae=rows.reduce((sum,row)=>sum+row.absoluteError,0)/rows.length,agreement=rows.filter(r=>r.absoluteError<=.2).length/rows.length;
    const result={id:randomUUID(),judge:judge.key,judgeVersion:judge.version,createdAt:new Date().toISOString(),examples:rows.length,meanAbsoluteError:mae,agreementWithinPointTwo:agreement,status:mae<=.2&&agreement>=.8?'meets-sample-threshold':'needs-review',rows,note:'Agreement on these labeled examples; not a general judge-quality certification.'};
    this.db.prepare('INSERT INTO judge_calibrations VALUES (?,?,?,?)').run(result.id,identity.tenant,environment,JSON.stringify(result));this.ops.audit(identity,'judge_calibrated',result.id,environment);return result;
  }
  importMetrics(identity,environment,input){
    if(!Array.isArray(input.rows)||!input.rows.length||input.rows.length>500)fail('Import 1–500 execution-linked metric rows.');
    const results=input.rows.map((row,index)=>{try{const result=this.runtime.outcome(identity.tenant,environment,row);return {row:index+1,status:result.duplicate?'duplicate':'accepted'};}catch(error){return {row:index+1,status:'rejected',message:error.status?error.message:'Invalid metric row.'};}});
    this.ops.audit(identity,'warehouse_metrics_imported',String(results.filter(r=>r.status==='accepted').length),environment);return {results,accepted:results.filter(r=>r.status==='accepted').length,rejected:results.filter(r=>r.status==='rejected').length};
  }
}
