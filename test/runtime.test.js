import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { RuntimeStore } from '../src/runtime-store.js';
import { createApp } from '../src/server.js';
import { RuntimeClient } from '../src/runtime-sdk.js';
import { validateResource } from '../src/runtime-schema.js';
import { verify } from 'node:crypto';
import { generate,runBenchmark } from '../src/playground.js';

const config=(changes={})=>({key:'support-agent',mode:'completion',enabled:true,defaultVariation:'baseline',rules:[],variations:[{id:'baseline',provider:'custom',model:'fast-model',weight:50,messages:[{role:'system',content:'Answer {{topic}} concisely.'}]},{id:'candidate',provider:'custom',model:'strong-model',weight:50,messages:[{role:'system',content:'Explain {{topic}} clearly.'}]}],...changes});
const context={userId:'one',attributes:{tier:'enterprise'}};
const fixture=()=>{const store=new Store();return{store,runtime:new RuntimeStore(store)};};
const resolve=(runtime,userId='one')=>runtime.resolve('a','development','support-agent',{context:{userId},variables:{topic:'support'}});

test('runtime configuration is versioned, targeted, customized and tenant/environment isolated',()=>{
  const {store,runtime}=fixture();try{
    runtime.save('a','development','owner','configs',config({rules:[{attribute:'tier',operator:'eq',value:'enterprise',variation:'candidate'}]}),0);
    const resolved=runtime.resolve('a','development','support-agent',{context,variables:{topic:'billing'}});
    assert.equal(resolved.variation,'candidate');assert.equal(resolved.configuration.messages[0].content,'Explain billing clearly.');
    assert.equal(runtime.history('a','development','configs','support-agent').length,1);
  }finally{store.close();}
});
test('runtime invariants reject missing variables, bad references and conflicting automation',()=>{
  const {store,runtime}=fixture();try{
    runtime.save('a','development','owner','configs',config(),0);
    assert.throws(()=>runtime.resolve('a','development','support-agent',{context}),{code:'MISSING_VARIABLE'});
    assert.throws(()=>runtime.get('b','development','configs','support-agent'),{code:'NOT_FOUND'});
    assert.throws(()=>runtime.get('a','production','configs','support-agent'),{code:'NOT_FOUND'});
    assert.throws(()=>runtime.save('a','development','owner','configs',config(),0),{code:'VERSION_CONFLICT'});
    assert.throws(()=>validateResource('configs',config({experiment:{mode:'ab'},guard:{minSamples:2,windowSeconds:60,maxErrorRate:.1,action:'pause'}})));
    assert.throws(()=>runtime.save('a','development','owner','configs',config({judge:'missing-judge'}),1),{code:'NOT_FOUND'});
  }finally{store.close();}
});
test('online evaluations use immutable judge versions and duplicate outcomes do not count twice',()=>{
  const {store,runtime}=fixture();try{
    runtime.save('a','development','owner','judges',{key:'answer-judge',type:'exact'},0);
    runtime.save('a','development','owner','configs',config({judge:'answer-judge'}),0);
    const execution=resolve(runtime);
    runtime.save('a','development','owner','judges',{key:'answer-judge',type:'contains'},1);
    const result=runtime.outcome('a','development',{traceId:execution.traceId,input:'Question',output:'yes',expected:'yes',metrics:{success:true,latencyMs:30,inputTokens:4,outputTokens:2,costUsd:.001,reward:1}});
    assert.equal(result.evaluation.score,1);assert.equal(result.evaluation.judgeVersion,1);
    assert.equal(runtime.outcome('a','development',{traceId:execution.traceId,metrics:{success:false}}).duplicate,true);
    assert.equal(runtime.metrics('a','development','support-agent').reduce((s,r)=>s+r.samples,0),1);
    assert.throws(()=>runtime.outcome('b','development',{traceId:execution.traceId,metrics:{success:true}}),{code:'NOT_FOUND'});
  }finally{store.close();}
});
test('guarded rollout restores a known version only once after the minimum sample size',()=>{
  const {store,runtime}=fixture();try{
    runtime.save('a','development','owner','configs',config(),0);
    runtime.save('a','development','owner','configs',config({guard:{minSamples:2,windowSeconds:60,maxErrorRate:.2,action:'rollback',rollbackVersion:1}}),1);
    const first=resolve(runtime,'one'),second=resolve(runtime,'two'),late=resolve(runtime,'three');
    assert.equal(runtime.outcome('a','development',{traceId:first.traceId,metrics:{success:false}}).automation,null);
    const result=runtime.outcome('a','development',{traceId:second.traceId,metrics:{success:false}});
    assert.equal(result.automation.action,'rollback');assert.equal(result.automation.toVersion,3);
    assert.equal(runtime.get('a','development','configs','support-agent').guard,undefined);
    assert.equal(runtime.outcome('a','development',{traceId:late.traceId,metrics:{success:false}}).automation,null);
    assert.equal(runtime.overview('a','development').alerts.length,1);
  }finally{store.close();}
});
test('guards do not use missing costs as zero-cost observations',()=>{
  const {store,runtime}=fixture();try{
    runtime.save('a','development','owner','configs',config({guard:{minSamples:2,windowSeconds:60,maxCostUsd:.1,action:'pause'}}),0);
    for(const id of ['one','two'])runtime.outcome('a','development',{traceId:resolve(runtime,id).traceId,metrics:{success:true}});
    assert.equal(runtime.get('a','development','configs','support-agent').enabled,true);
    for(const id of ['three','four'])runtime.outcome('a','development',{traceId:resolve(runtime,id).traceId,metrics:{success:true,costUsd:1}});
    assert.equal(runtime.get('a','development','configs','support-agent').enabled,false);
  }finally{store.close();}
});
test('adaptive trigger switches future traffic with an audit trail',()=>{
  const {store,runtime}=fixture();try{
    runtime.save('a','development','owner','configs',config({trigger:{metric:'errorRate',threshold:.2,minSamples:2,windowSeconds:60,variation:'candidate'}}),0);
    for(const id of ['one','two'])runtime.outcome('a','development',{traceId:resolve(runtime,id).traceId,metrics:{success:false}});
    const saved=runtime.get('a','development','configs','support-agent');assert.equal(saved.defaultVariation,'candidate');assert.equal(saved.variations[1].weight,100);
    assert.equal(resolve(runtime,'three').variation,'candidate');assert.equal(runtime.overview('a','development').alerts[0].action,'switch');
  }finally{store.close();}
});
test('bandit assignment persists for a subject and learns observed rewards',()=>{
  const {store,runtime}=fixture();try{
    runtime.save('a','development','owner','configs',config({experiment:{mode:'bandit',epsilon:.1}}),0);
    const first=resolve(runtime,'initial');runtime.outcome('a','development',{traceId:first.traceId,metrics:{success:true,reward:0}});
    const second=resolve(runtime,'next');assert.notEqual(second.variation,first.variation);runtime.outcome('a','development',{traceId:second.traceId,metrics:{success:true,reward:1}});
    assert.equal(resolve(runtime,'initial').variation,first.variation);
    let winner=0;for(let n=0;n<200;n++)if(resolve(runtime,`new-${n}`).variation===second.variation)winner++;
    assert.ok(winner>160);
  }finally{store.close();}
});
test('offline benchmark pins versions and rejects incomplete row coverage',()=>{
  const {store,runtime}=fixture();try{
    runtime.save('a','development','owner','configs',config(),0);
    runtime.save('a','development','owner','judges',{key:'answer-judge',type:'exact'},0);
    runtime.save('a','development','owner','datasets',{key:'support-cases',rows:[{id:'one',input:'Q1',expected:'yes'},{id:'two',input:'Q2',expected:'no'}]},0);
    const body={config:'support-agent',dataset:'support-cases',judge:'answer-judge',outputs:[{rowId:'one',variation:'baseline',output:'yes'},{rowId:'two',variation:'baseline',output:'wrong'}]};
    assert.equal(runtime.benchmark('a','development',body).summaries[0].meanScore,.5);
    assert.throws(()=>runtime.benchmark('a','development',{...body,outputs:body.outputs.slice(0,1)}));
    assert.equal(runtime.overview('a','development').evaluations.length,1);
  }finally{store.close();}
});
test('graphs support cycles, reject orphan nodes and resolve configs atomically',()=>{
  const {store,runtime}=fixture();try{
    runtime.save('a','development','owner','tools',{key:'lookup-tool',description:'Read approved information',inputSchema:{type:'object'},requiresApproval:false},0);
    const agent=config({mode:'agent',variations:config().variations.map(v=>({...v,messages:undefined,instructions:'Help with {{topic}}',tools:['lookup-tool']}))});
    runtime.save('a','development','owner','configs',agent,0);
    const graph={key:'support-flow',root:'helper',maxSteps:3,nodes:[{id:'helper',config:'support-agent'}],edges:[{from:'helper',to:'helper'}]};
    runtime.save('a','development','owner','graphs',graph,0);
    const resolved=runtime.graph('a','development','support-flow',{context,variables:{topic:'billing'}});assert.equal(resolved.nodes.length,1);
    assert.equal(resolved.nodes[0].resolved.graphTraceId,resolved.traceId);
    assert.throws(()=>validateResource('graphs',{...graph,nodes:[...graph.nodes,{id:'orphan',config:'support-agent'}]}));
  }finally{store.close();}
});
test('signed snapshots can be verified and tampering is detectable',()=>{
  const {store,runtime}=fixture();try{
    runtime.save('a','development','owner','configs',config(),0);
    const snapshot=runtime.snapshot('a','development');
    assert.equal(verify(null,Buffer.from(snapshot.payload),snapshot.publicKey,Buffer.from(snapshot.signature,'base64')),true);
    assert.equal(verify(null,Buffer.from(snapshot.payload+' '),snapshot.publicKey,Buffer.from(snapshot.signature,'base64')),false);
    assert.ok(JSON.parse(snapshot.payload).expiresAt>Date.now());
  }finally{store.close();}
});
test('progressive rollout waits for time and samples before advancing its pinned version',()=>{
  const {store,runtime}=fixture();try{
    runtime.save('a','development','owner','configs',config({progressive:{variation:'candidate',steps:[10,50,100],intervalSeconds:1,minSamples:2}}),0);
    let users=[];for(let n=0;users.length<2;n++){const decision=resolve(runtime,String(n));if(decision.variation==='candidate')users.push(decision);}
    store.db.prepare('UPDATE runtime_rollouts SET startedAt=?').run(new Date(Date.now()-2000).toISOString());
    runtime.outcome('a','development',{traceId:users[0].traceId,metrics:{success:true}});
    const next=runtime.outcome('a','development',{traceId:users[1].traceId,metrics:{success:true}});
    assert.equal(next.automation.rollout,50);assert.equal(runtime.get('a','development','configs','support-agent').version,1);
  }finally{store.close();}
});
test('model and tool libraries pin reusable definitions into config versions',()=>{
  const {store,runtime}=fixture();try{
    runtime.save('a','development','owner','models',{key:'fast-profile',provider:'custom',model:'model-one',parameters:{temperature:.1}},0);
    runtime.save('a','development','owner','tools',{key:'lookup-tool',description:'Read approved docs',inputSchema:{type:'object'},requiresApproval:true},0);
    const body=config();body.variations[0].modelRef='fast-profile';body.variations[0].tools=['lookup-tool'];
    const saved=runtime.save('a','development','owner','configs',body,0);
    runtime.save('a','development','owner','models',{key:'fast-profile',provider:'custom',model:'model-two',parameters:{}},1);
    assert.equal(saved.variations[0].model,'model-one');assert.equal(saved.variations[0].modelVersion,1);assert.equal(saved.variations[0].toolDefinitions[0].requiresApproval,true);
  }finally{store.close();}
});
test('approval workflow prevents self-approval and stale requests cannot overwrite changes',()=>{
  const {store,runtime}=fixture();try{
    const pending=runtime.requestApproval('a','production','owner','configs',config(),0);
    assert.throws(()=>runtime.get('a','production','configs','support-agent'),{code:'NOT_FOUND'});
    assert.throws(()=>runtime.review('a','production','owner',pending.id,'approve'),{code:'SELF_APPROVAL'});
    assert.equal(runtime.review('a','production','reviewer',pending.id,'approve').resource.version,1);
    const stale=runtime.requestApproval('a','production','owner','configs',config(),1);
    runtime.save('a','production','owner','configs',config(),1);
    assert.throws(()=>runtime.review('a','production','reviewer',stale.id,'approve'),{code:'VERSION_CONFLICT'});
    assert.equal(runtime.approvals('a','production').find(r=>r.id===stale.id).status,'pending');
    assert.equal(runtime.review('a','production','reviewer',stale.id,'reject').status,'rejected');
  }finally{store.close();}
});
test('provider-backed playground and offline generation do not mutate production or live metrics',async()=>{
  const {store,runtime}=fixture();try{
    runtime.save('a','production','owner','configs',config(),0);
    runtime.save('a','production','owner','judges',{key:'answer-judge',type:'exact'},0);
    runtime.save('a','production','owner','datasets',{key:'support-cases',rows:[{id:'one',input:'test',expected:'correct',variables:{topic:'billing'}}]},0);
    const providers={custom:async()=>({output:'correct',inputTokens:3,outputTokens:2})};
    const run=await generate(runtime,providers,'a','production',{config:'support-agent',variation:'baseline',input:'test',variables:{topic:'billing'},judge:'answer-judge',expected:'correct'});
    assert.equal(run.evaluation.score,1);runtime.savePlayground('a','production',run);assert.equal(runtime.playgroundHistory('a','production').length,1);
    const result=await runBenchmark(runtime,providers,'a','production',{config:'support-agent',dataset:'support-cases',judge:'answer-judge'});assert.equal(result.summaries[1].meanScore,1);
    assert.equal(runtime.overview('a','production').executions.length,0);assert.equal(runtime.get('a','production','configs','support-agent').version,1);
    await assert.rejects(()=>generate(runtime,{},'a','production',{config:'support-agent',variation:'baseline',input:'test',variables:{topic:'billing'}}),{code:'PROVIDER_NOT_CONFIGURED'});
  }finally{store.close();}
});
test('runtime SDK executes, judges, retries once and benchmarks through real HTTP',async()=>{
  const store=new Store();const runtime=new RuntimeStore(store);
  runtime.save('a','development','owner','judges',{key:'answer-judge',type:'exact'},0);
  runtime.save('a','development','owner','datasets',{key:'support-cases',rows:[{id:'one',input:'test',expected:'correct',variables:{topic:'billing'}}]},0);
  const variants=config().variations.map((v,i)=>({...v,weight:i===0?100:0}));
  runtime.save('a','development','owner','configs',config({variations:variants,judge:'answer-judge',retry:{variation:'candidate',minQuality:.8}}),0);
  const app=createApp({store,credentials:[{token:'owner',tenant:'a',actor:'owner',role:'owner'},{token:'reader',tenant:'a',actor:'reader',role:'read-only'}]});
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
  const baseUrl=`http://127.0.0.1:${app.address().port}`;
  const provider=async({configuration})=>({output:configuration.id==='baseline'?'wrong':'correct',inputTokens:2,outputTokens:1,costUsd:.001});
  const client=new RuntimeClient({baseUrl,token:'owner',providers:{custom:provider}});
  try{
    const result=await client.execute('support-agent',{context,variables:{topic:'billing'},input:'test',expected:'correct'});
    assert.equal(result.output,'correct');assert.equal(result.attempts.length,2);assert.equal(result.attempts[0].metrics.quality,0);assert.equal(result.attempts[1].metrics.quality,1);
    const benchmark=await client.benchmark({config:'support-agent',dataset:'support-cases',judge:'answer-judge',executor:async()=>({output:'correct'})});assert.equal(benchmark.summaries.length,2);
    const reader=new RuntimeClient({baseUrl,token:'reader'});
    await assert.rejects(()=>reader.request('configs/support-agent','PUT',config()),{status:403});
    await assert.rejects(()=>client.request('configs/support-agent/retry','POST',{traceId:result.traceId,variables:{topic:'billing'}}),{code:'RETRY_NOT_ALLOWED'});
  }finally{await new Promise(resolve=>app.close(resolve));store.close();}
});
test('LLM judges receive rubric and input/output, and scores are recorded through the SDK',async()=>{
  const store=new Store(),runtime=new RuntimeStore(store);let judgeCalls=0;
  runtime.save('a','development','owner','judges',{key:'quality-judge',type:'llm',provider:'custom',model:'judge-model',prompt:'Score factuality. Return JSON with score and reason.'},0);
  runtime.save('a','development','owner','configs',config({judge:'quality-judge'}),0);
  const app=createApp({store,credentials:[{token:'owner',tenant:'a',actor:'owner',role:'owner'}]});await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
  const client=new RuntimeClient({baseUrl:`http://127.0.0.1:${app.address().port}`,token:'owner',providers:{custom:async({judge,configuration})=>{if(judge){judgeCalls++;assert.equal(configuration.model,'judge-model');assert.ok(configuration.messages[0].content.includes('factuality'));return{output:'{"score":0.85,"reason":"Supported answer."}'};}return{output:'The answer.'};}}});
  try{const result=await client.execute('support-agent',{context,variables:{topic:'facts'},input:'Question'});assert.equal(result.attempts[0].metrics.quality,.85);assert.equal(judgeCalls,1);assert.equal(runtime.overview('a','development').executions[0].outcome.evaluation.source,'application-llm-judge');}finally{await new Promise(resolve=>app.close(resolve));store.close();}
});
test('graph SDK traverses cycles with bounded visits, pinned node configs and graph metrics',async()=>{
  const store=new Store(),runtime=new RuntimeStore(store);
  const agent=config({mode:'agent',variations:config().variations.map(v=>({...v,messages:undefined,instructions:'Help with {{topic}}'}))});
  runtime.save('a','development','owner','configs',agent,0);
  runtime.save('a','development','owner','graphs',{key:'support-flow',root:'helper',maxSteps:3,nodes:[{id:'helper',config:'support-agent'}],edges:[{from:'helper',to:'helper'}]},0);
  const app=createApp({store,credentials:[{token:'owner',tenant:'a',actor:'owner',role:'owner'}]});await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
  const client=new RuntimeClient({baseUrl:`http://127.0.0.1:${app.address().port}`,token:'owner'});let calls=0;
  try{
    const result=await client.runGraph('support-flow',{context,variables:{topic:'billing'},input:'help',executor:async()=>{calls++;if(calls===1)runtime.save('a','development','owner','configs',agent,1);return{output:'answer'};}});
    assert.equal(result.status,'step_limit');assert.equal(calls,3);assert.equal(new Set(result.visits.map(v=>v.resolved.traceId)).size,3);assert.ok(result.visits.every(v=>v.resolved.version===1));assert.equal(runtime.graphMetrics('a','development','support-flow').samples,3);
  }finally{await new Promise(resolve=>app.close(resolve));store.close();}
});
test('AI insights preserve historical versions after safety actions and enforce valid windows',()=>{
  const {store,runtime}=fixture();try{
    runtime.save('a','development','owner','configs',config(),0);
    runtime.outcome('a','development',{traceId:resolve(runtime).traceId,metrics:{success:true,quality:.9,costUsd:.01,latencyMs:30}});
    runtime.save('a','development','owner','configs',config({enabled:false}),1);
    const result=runtime.insights('a','development');assert.equal(result.summary.samples,1);assert.equal(result.variations[0].version,1);assert.equal(result.timeline.length,1);assert.equal(runtime.insights('b','development').summary.samples,0);
    assert.throws(()=>runtime.insights('a','development',{from:'invalid'}));
  }finally{store.close();}
});
