import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { RuntimeStore } from '../src/runtime-store.js';
import { Operations } from '../src/operations.js';
import { ReleaseWorkflows } from '../src/release-workflows.js';
import { experimentAnalysis } from '../src/analysis.js';
import { createApp } from '../src/server.js';
import { RuntimeClient } from '../src/runtime-sdk.js';
import { anthropicAdapter } from '../src/providers.js';
const base={key:'support',mode:'completion',enabled:true,defaultVariation:'base',variations:[{id:'base',provider:'custom',model:'fixture',weight:50,messages:[{role:'system',content:'Help'}]},{id:'candidate',provider:'custom',model:'fixture',weight:50,messages:[{role:'system',content:'Help better'}]}]};

test('snippets pin prompt versions, reject cross-tenant references and promote distinct versions into existing libraries',()=>{
  const store=new Store(),runtime=new RuntimeStore(store),ops=new Operations(runtime),flows=new ReleaseWorkflows(ops),identity={tenant:'team',actor:'owner'};
  try {
    runtime.save('team','development','owner','snippets',{key:'policy',content:'First {{topic}}'},0);
    const first=runtime.save('team','development','owner','configs',{...base,variations:base.variations.map(v=>({...v,messages:[{role:'system',snippetRef:{key:'policy'}}]}))},0);
    assert.equal(first.variations[0].messages[0].snippetRef.version,1);
    runtime.save('team','development','owner','snippets',{key:'policy',content:'Second {{topic}}'},1);
    const pinned=runtime.save('team','development','owner','configs',first,1);
    assert.equal(pinned.variations[0].messages[0].content,'First {{topic}}');
    const updated=structuredClone(pinned);updated.variations[1].messages[0].snippetRef.version=2;
    runtime.save('team','development','owner','configs',updated,2);
    assert.throws(()=>runtime.save('other','development','owner','configs',updated,0),{code:'NOT_FOUND'});
    for(let i=0;i<3;i++)runtime.save('team','staging','owner','snippets',{key:'policy',content:'Unrelated '+i},i);
    const plan=flows.create(identity,'development',{config:'support',stages:['staging'],minSamples:2,minQuality:.8});flows.advance(identity,'development',plan.id);
    const target=runtime.get('team','staging','configs','support');
    assert.equal(target.variations[0].messages[0].snippetRef.version,4);
    assert.equal(target.variations[1].messages[0].snippetRef.version,5);
    assert.equal(target.variations[0].messages[0].content,'First {{topic}}');
    assert.equal(target.variations[1].messages[0].content,'Second {{topic}}');
    assert.equal(runtime.resolve('team','staging','support',{context:{userId:'test'},variables:{topic:'support'}}).configuration.messages[0].content.includes('{{'),false);
  } finally {ops.close();store.close();}
});

function evidence(runtime,environment,config){
  for(const variation of config.variations)for(let i=0;i<300;i++){
    const id=`${variation.id}-${i}`,subject=id,metrics={success:true,reward:variation.id==='candidate'?1:0};
    runtime.db.prepare('INSERT INTO runtime_executions VALUES (?,?,?,?,?,?,?,?,?)').run(id,'team',environment,config.key,config.version,variation.id,new Date().toISOString(),JSON.stringify({metrics,timestamp:new Date().toISOString()}),JSON.stringify({config,subject,reason:'experiment'}));
  }
}
test('conclusive experiment promotion is opt-in, idempotent and respects production approval',()=>{
  for(const environment of ['development','production']){
    const store=new Store(),runtime=new RuntimeStore(store);runtime.requireProductionApproval=true;
    try {
      const config=runtime.save('team',environment,'owner','configs',{...base,experiment:{mode:'ab',metric:'reward',minSamples:30,autoPromote:true}},0);evidence(runtime,environment,config);
      const result=runtime.transaction(()=>runtime.automate('team',environment,config));
      if(environment==='development'){assert.equal(result.action,'promote');const promoted=runtime.get('team',environment,'configs','support');assert.equal(promoted.defaultVariation,'candidate');assert.equal(promoted.experiment,undefined);assert.equal(promoted.variations[1].weight,100);}
      else {assert.equal(result.action,'promotion_review');assert.equal(runtime.get('team',environment,'configs','support').version,1);assert.equal(runtime.transaction(()=>runtime.automate('team',environment,config)),null);runtime.review('team',environment,'reviewer',result.approval,'approve');assert.equal(runtime.get('team',environment,'configs','support').defaultVariation,'candidate');}
    } finally {store.close();}
  }
});
test('experiment winner must beat every active arm, not merely the baseline',()=>{
  const config={...base,variations:[...base.variations,{...base.variations[1],id:'other',weight:34}].map((v,i)=>({...v,weight:i===2?34:33})),experiment:{mode:'ab',metric:'reward'}};
  const records=config.variations.flatMap(v=>Array.from({length:300},(_,i)=>({id:v.id+i,subject:v.id+i,variation:v.id,reason:'experiment',metrics:{reward:v.id==='base'?0:1}})));
  assert.equal(experimentAnalysis(config,records).winner,null);
});
test('Node SDK passes approved tools, images and streamed events through real resolve/outcome HTTP',async()=>{
  const store=new Store(),app=createApp({store,workerMode:'disabled',credentials:[{token:'sdk-fixture',tenant:'team',actor:'owner',role:'owner'}]}),runtime=app.operations.runtime;
  runtime.save('team','development','owner','tools',{key:'calculator',description:'Add values',requiresApproval:true,inputSchema:{type:'object',properties:{values:{type:'array',items:{type:'number'}}},required:['values']}},0);
  runtime.save('team','development','owner','configs',{key:'agent-tools',mode:'agent',enabled:true,defaultVariation:'base',sampleRate:0,variations:[{id:'base',provider:'anthropic',model:'fixture',weight:100,instructions:'Use approved tools.',tools:['calculator']}]},0);
  await new Promise(done=>app.listen(0,'127.0.0.1',done));let turn=0;const requests=[];
  const provider=anthropicAdapter({apiKey:'fixture',fetchImpl:async(url,request)=>{requests.push(JSON.parse(request.body));const content=turn++===0?{type:'tool_use',id:'call',name:'calculator',input:{values:[2,3]}}:{type:'text',text:'Five'};const events=[{type:'message_start',message:{usage:{input_tokens:2}}},{type:'content_block_start',index:0,content_block:content},{type:'message_delta',delta:{stop_reason:turn===1?'tool_use':'end_turn'},usage:{output_tokens:1}},{type:'message_stop'}];if(content.type==='text'){events[1].content_block={type:'text',text:''};events.splice(2,0,{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Five'}});}return new Response(events.map(e=>`data: ${JSON.stringify(e)}\n\n`).join(''));}});
  const client=new RuntimeClient({baseUrl:`http://127.0.0.1:${app.address().port}`,token:'sdk-fixture',providers:{anthropic:provider}}),events=[];
  try{const result=await client.execute('agent-tools',{context:{userId:'sdk-user'},input:'Add',attachments:[{data:'data:image/png;base64,aGVsbG8='}],approvedTools:['calculator'],toolHandlers:{calculator:async({values})=>({value:values.reduce((a,b)=>a+b,0)})},onEvent:event=>events.push(event)});assert.equal(result.output,'Five');assert.equal(result.attempts[0].telemetryError,undefined);assert.equal(events[0].text,'Five');assert.equal(requests[0].messages[0].content[1].type,'image');assert.equal(runtime.metrics('team','development','agent-tools')[0].samples,1);}finally{await new Promise(done=>app.close(done));store.close();}
});
