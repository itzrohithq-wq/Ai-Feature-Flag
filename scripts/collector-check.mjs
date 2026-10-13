import {spawnSync} from 'node:child_process';import {resolve} from 'node:path';import {randomUUID} from 'node:crypto';import {mkdirSync,writeFileSync} from 'node:fs';import assert from 'node:assert/strict';
const suffix=randomUUID().slice(0,8),network=`studio-otel-${suffix}`,app=`studio-otel-app-${suffix}`,collector=`studio-otel-collector-${suffix}`,label=`control-studio.collector-check=${suffix}`,token='isolated-collector-test-token';
const docker=(...args)=>{const result=spawnSync('docker',args,{encoding:'utf8',timeout:120000});if(result.status!==0)throw new Error(`Docker ${args[0]} failed: ${result.stderr}`);return result.stdout.trim();};
const port=name=>Number(docker('port',name,name===app?'4315/tcp':'4318/tcp').split(':').at(-1));
const wait=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));
const varint=value=>{let n=BigInt(value),parts=[];while(n>127n){parts.push(Number(n&127n)|128);n>>=7n;}parts.push(Number(n));return Buffer.from(parts);};
const message=(field,bytes)=>Buffer.concat([varint(field*8+2),varint(bytes.length),bytes]);const string=(field,value)=>message(field,Buffer.from(value));const concat=(...values)=>Buffer.concat(values);
const fixed=(field,value)=>{const bytes=Buffer.alloc(8);bytes.writeBigUInt64LE(BigInt(value));return concat(varint(field*8+1),bytes);};
const attribute=(key,value)=>concat(string(1,key),message(2,string(1,value)));
let createdNetwork=false;const containers=[];
try{
  docker('network','create','--label',label,network);createdNetwork=true;
  docker('run','-d','--name',app,'--label',label,'--network',network,'--network-alias','studio-fixture','-p','127.0.0.1::4315','-e',`FLAG_ADMIN_TOKEN=${token}`,'-e','WORKER_MODE=disabled','control-studio:verification');containers.push(app);
  const base=`http://127.0.0.1:${port(app)}`;let ready=false;for(let i=0;i<60;i++){try{ready=(await fetch(base+'/health')).ok;}catch{}if(ready)break;await wait(250);}assert.ok(ready,'Fixture application startup');
  const api=async(path,method='GET',body)=>{const response=await fetch(base+'/api/runtime/'+path,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const result=await response.json();assert.ok(response.ok,JSON.stringify(result));return result;};
  await api('configs/support','PUT',{expectedVersion:0,mode:'completion',enabled:true,defaultVariation:'base',variations:[{id:'base',provider:'custom',model:'fixture',weight:100,messages:[{role:'system',content:'Help'}]}]});const resolved=await api('configs/support/resolve','POST',{context:{userId:'collector-fixture'}});
  const telemetry=await api('credentials','POST',{actor:'collector',role:'reader',days:1,policy:{environments:['development'],resources:['telemetry']}});
  docker('run','-d','--name',collector,'--label',label,'--network',network,'-p','127.0.0.1::4318','-e','STUDIO_OTLP_ENDPOINT=http://studio-fixture:4315/api/runtime/otlp','-e',`STUDIO_TELEMETRY_TOKEN=${telemetry.token}`,'--mount',`type=bind,source=${resolve('deploy/otel-collector.yaml')},target=/etc/otelcol/config.yaml,readonly`,'otel/opentelemetry-collector:0.160.0','--config=/etc/otelcol/config.yaml');containers.push(collector);
  const started=BigInt(Date.now())*1000000n;
  const span=concat(message(1,Buffer.from('a'.repeat(32),'hex')),message(2,Buffer.from('b'.repeat(16),'hex')),string(5,'collector protobuf generation'),fixed(7,started),fixed(8,started+10000000n),message(9,attribute('runtime.execution_id',resolved.traceId)),message(15,concat(varint(24),varint(2))));
  const resource=message(1,attribute('service.name','protobuf-fixture'));const payload=message(1,concat(message(1,resource),message(2,message(2,span))));
  let response;for(let i=0;i<60;i++){try{response=await fetch(`http://127.0.0.1:${port(collector)}/v1/traces`,{method:'POST',headers:{'Content-Type':'application/x-protobuf'},body:payload});}catch{}if(response)break;await wait(250);}assert.equal(response?.status,200,'Collector protobuf ingestion');
  let spans=[];for(let i=0;i<40;i++){spans=await api('traces');if(spans.length)break;await wait(250);}assert.equal(spans[0]?.name,'collector protobuf generation');assert.equal(spans[0].resource.attributes[0].value.stringValue,'protobuf-fixture');const metrics=await api('configs/support/metrics');assert.equal(metrics[0].errorRate,1);
  const report={timestamp:new Date().toISOString(),passed:true,collector:'otel/opentelemetry-collector:0.160.0',transport:'OTLP HTTP protobuf → Collector → authenticated OTLP JSON',resourcePreserved:true,executionOutcomeLinked:true,scopedCredential:true};mkdirSync('data/verification',{recursive:true});writeFileSync('data/verification/collector.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{
  for(const name of containers.reverse()){const owner=docker('inspect','--format','{{index .Config.Labels "control-studio.collector-check"}}',name);if(owner!==suffix)throw new Error('Refusing to remove an unowned container.');docker('rm','-f',name);}
  if(createdNetwork){const owner=docker('network','inspect','--format','{{index .Labels "control-studio.collector-check"}}',network);if(owner!==suffix)throw new Error('Refusing to remove an unowned network.');docker('network','rm',network);}
}
