import test from 'node:test';import assert from 'node:assert/strict';import {Store} from '../src/store.js';import {createApp} from '../src/server.js';
test('collector endpoint accepts OTLP JSON, links error outcomes and confines telemetry credentials',async()=>{
  const store=new Store(),app=createApp({store,workerMode:'disabled'}),ops=app.operations,runtime=ops.runtime;
  const owner={tenant:'team',actor:'owner'};const credential=ops.issue(owner,{actor:'collector',role:'reader',days:1,policy:{environments:['development'],resources:['telemetry']}});
  await new Promise(done=>app.listen(0,'127.0.0.1',done));const base=`http://127.0.0.1:${app.address().port}`;
  try{
    runtime.save('team','development','owner','configs',{key:'support',mode:'completion',enabled:true,defaultVariation:'base',variations:[{id:'base',provider:'custom',model:'fixture',weight:100,messages:[{role:'system',content:'Help'}]}]},0);
    const resolved=runtime.resolve('team','development','support',{context:{userId:'collector-user'}});
    const span={traceId:'a'.repeat(32),spanId:'b'.repeat(16),parentSpanId:'c'.repeat(16),name:'generation',startTimeUnixNano:'1000000',endTimeUnixNano:'3000000',status:{code:'STATUS_CODE_ERROR'},attributes:[{key:'runtime.execution_id',value:{stringValue:resolved.traceId}}]};
    const body={resourceSpans:[{resource:{attributes:[{key:'service.name',value:{stringValue:'fixture-service'}}]},scopeSpans:[{scope:{name:'fixture'},spans:[span]}]}]};
    const headers={Authorization:`Bearer ${credential.token}`,'Content-Type':'application/json'};
    const response=await fetch(base+'/api/runtime/otlp',{method:'POST',headers,body:JSON.stringify(body)});assert.equal(response.status,200);assert.deepEqual(await response.json(),{});
    const trace=ops.traces('team','development')[0];assert.equal(trace.resource.attributes[0].value.stringValue,'fixture-service');assert.equal(trace.parentSpanId,span.parentSpanId);assert.equal(runtime.metrics('team','development','support')[0].errorRate,1);
    assert.equal((await fetch(base+'/api/runtime/configs',{headers})).status,403);
    assert.equal((await fetch(base+'/api/runtime/traces?environment=production',{headers})).status,403);
    assert.equal(ops.traces('other','development').length,0);
    const invalid={...span,parentSpanId:'invalid'};const bad=await fetch(base+'/api/runtime/otlp',{method:'POST',headers,body:JSON.stringify({spans:[invalid]})});assert.equal(bad.status,400);
  }finally{await new Promise(done=>app.close(done));store.close();}
});
