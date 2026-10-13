import { verify,randomUUID,createHash } from 'node:crypto';
import { scoreJudge,matches,customize } from './runtime-schema.js';

export async function bounded(action, milliseconds) {
  const controller=new AbortController();
  let timer;
  const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('Execution timed out.'));},milliseconds);});
  try{return await Promise.race([Promise.resolve().then(()=>action(controller.signal)),timeout]);}finally{clearTimeout(timer);}
}

export class RuntimeClient {
  constructor({baseUrl,token,environment='development',providers={},timeoutMs=30000,requestTimeoutMs=5000,trustedPublicKey,traceEnabled=false,tenant}) {
    this.baseUrl=baseUrl.replace(/\/$/,'');this.token=token;this.environment=environment;this.providers=providers;this.timeoutMs=timeoutMs;this.requestTimeoutMs=requestTimeoutMs;this.trustedPublicKey=trustedPublicKey;
    this.traceEnabled=traceEnabled;
    this.tenant=tenant;
  }
  async request(path,method='GET',body) {
    const response=await fetch(`${this.baseUrl}/api/runtime/${path}?environment=${encodeURIComponent(this.environment)}`,{method,headers:{Authorization:`Bearer ${this.token}`,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(this.requestTimeoutMs)});
    const result=await response.json();if(!response.ok)throw Object.assign(new Error(result.error.message),{code:result.error.code,status:response.status});return result;
  }
  resolve(key,context,variables={}) {return this.request(`configs/${encodeURIComponent(key)}/resolve`,'POST',{context,variables});}
  async *watch(key,{signal}={}){const response=await fetch(`${this.baseUrl}/api/runtime/configs/${encodeURIComponent(key)}/watch?environment=${encodeURIComponent(this.environment)}`,{headers:{Authorization:`Bearer ${this.token}`},signal});if(!response.ok)throw new Error(`Configuration stream failed (${response.status}).`);const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';try{while(true){const {value,done}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});let index;while((index=buffer.indexOf('\n\n'))>=0){const event=buffer.slice(0,index);buffer=buffer.slice(index+2);const data=event.split('\n').find(line=>line.startsWith('data: '));if(data)yield JSON.parse(data.slice(6));}}}finally{await reader.cancel();}}
  async cacheSnapshot(){if(!this.tenant)throw new Error('Set the expected tenant before caching snapshots.');this.cachedSnapshot=await this.verifiedSnapshot();return this.cachedSnapshot;}
  async resolveWithFallback(key,context,variables={}){try{return await this.resolve(key,context,variables);}catch(error){if(error.status&&error.status<500)throw error;const snapshot=this.cachedSnapshot;if(!snapshot||snapshot.expiresAt<Date.now())throw error;const config=snapshot.configs.find(c=>c.key===key);if(!config||typeof context?.userId!=='string'||!context.userId)throw error;let id=config.defaultVariation;const safeOnly=config.progressive||config.guard||config.trigger||config.retry||config.experiment;if(config.enabled&&!safeOnly){const rule=(config.rules??[]).find(r=>matches(r,context));if(rule)id=rule.variation;else{const hash=createHash('sha256').update(JSON.stringify([snapshot.tenant,this.environment,key,context.userId,'ab'])).digest('hex'),point=parseInt(hash.slice(0,8),16)/4294967296*100;let sum=0;for(const v of config.variations){sum+=v.weight;if(point<sum){id=v.id;break;}}}}return {key,environment:this.environment,version:config.version,variation:id,configuration:customize(config.variations.find(v=>v.id===id),variables),mode:config.mode,judge:null,judges:[],sampled:false,retry:null,traceId:null,offline:true,reason:safeOnly?'cached-safe-default':'cached',expiresAt:snapshot.expiresAt};}}
  async judge(config,input,output,expected) {
    if(!config.judge || !config.sampled) return null;
    const judge=config.judge;
    if(judge.type!=='llm') return scoreJudge(judge,input,output,expected);
    const provider=this.providers[judge.provider];if(!provider)throw new Error(`Register the ${judge.provider} adapter to invoke the LLM judge.`);
    const response=await bounded(signal=>provider({mode:'completion',configuration:{provider:judge.provider,model:judge.model,parameters:{},messages:[{role:'system',content:judge.prompt},{role:'user',content:JSON.stringify({input,output,expected:expected ?? null})}]},input,signal,judge:true}),this.timeoutMs);
    const result=typeof response.judgement==='object'?response.judgement:JSON.parse(response.output);
    if(!Number.isFinite(result.score)||result.score<0||result.score>1||typeof result.reason!=='string')throw new Error('LLM judge must return JSON with score 0–1 and reason.');return {score:result.score,reason:result.reason};
  }
  async attempt(resolved,{input,expected,executor,reward,satisfaction,attachments=[],onEvent,toolHandlers={},approvedTools=[]}) {
    const provider=executor ?? this.providers[resolved.configuration.provider];
    if(!provider) throw new Error(`Register an adapter for ${resolved.configuration.provider}.`);
    const started=performance.now(),spanStart=BigInt(Date.now())*1000000n;let completion,error;
    try {
      completion=await bounded(signal=>provider({configuration:resolved.configuration,mode:resolved.mode,input,signal,attachments,onEvent,toolHandlers,approvedTools}),this.timeoutMs);
      if(!completion || typeof completion.output!=='string')throw new Error('Provider adapters must return an output string.');
    }catch(cause){error=cause;}
    const latencyMs=performance.now()-started;
    let judgement=null,judgeError=null;
    const judgements={};
    if(completion&&!error)try{if(resolved.judges?.length){for(const judge of resolved.judges){const score=await this.judge({...resolved,judge},input,completion.output,expected);if(score)judgements[judge.key]=score;}const values=Object.values(judgements);if(values.length)judgement={score:values.reduce((sum,v)=>sum+v.score,0)/values.length,reason:'Mean of attached judges'};}else judgement=await this.judge(resolved,input,completion.output,expected);}catch(cause){judgeError=cause.message;}
    const metrics={success:!error,latencyMs,...Object.fromEntries(['costUsd','inputTokens','outputTokens','firstTokenMs','quality'].filter(k=>completion?.[k]!==undefined).map(k=>[k,completion[k]])),...(reward!==undefined?{reward}:{}),...(satisfaction!==undefined?{satisfaction}:{}),...(judgement?{quality:judgement.score}:{})};
    const event={traceId:resolved.traceId,metrics,...(judgement?{input,output:completion.output,judgements,...(expected!==undefined?{expected}:{}),...(resolved.judge?.type==='llm'?{judgement}:{})}:{})};
    let telemetry,telemetryError;
    try{telemetry=await this.request('outcomes','POST',event);}catch(cause){telemetryError=cause.message;}
    let traceError;
    if(this.traceEnabled)try{await this.request('traces','POST',{spans:[{traceId:resolved.traceId.replaceAll('-',''),spanId:randomUUID().replaceAll('-','').slice(0,16),name:'gen_ai.generate',startTimeUnixNano:String(spanStart),endTimeUnixNano:String(BigInt(Date.now())*1000000n),attributes:[{key:'runtime.execution_id',value:{stringValue:resolved.traceId}},{key:'gen_ai.request.model',value:{stringValue:resolved.configuration.model}},{key:'gen_ai.system',value:{stringValue:resolved.configuration.provider}}],status:{code:error?2:1}}]});}catch(cause){traceError=cause.message;}
    return {resolved,output:error?null:completion.output,metrics,judgement,judgeError,telemetry,telemetryError,traceError,error:error?.message ?? null};
  }
  async execute(key,{context,variables={},input,expected,executor,reward,satisfaction,attachments=[],onEvent,toolHandlers={},approvedTools=[]}) {
    let resolved=await this.resolve(key,context,variables);
    const attempts=[await this.attempt(resolved,{input,expected,executor,reward,satisfaction,attachments,onEvent,toolHandlers,approvedTools})];
    const first=attempts[0];
    if(resolved.retry && !first.telemetryError && (first.error || (first.metrics.quality!==undefined && first.metrics.quality<resolved.retry.minQuality))) {
      try {
        resolved=await this.request(`configs/${encodeURIComponent(key)}/retry`,'POST',{traceId:resolved.traceId,variables});
        attempts.push(await this.attempt(resolved,{input,expected,executor,reward,satisfaction,attachments,onEvent,toolHandlers,approvedTools}));
      }catch(cause){first.retryError=cause.message;}
    }
    const last=attempts.at(-1);
    return {output:last.output,error:last.error,traceId:last.resolved.traceId,attempts};
  }
  async benchmark({config,dataset,judge,executor,context={userId:'offline-evaluation'}}) {
    const [configuration,data,criterion]=await Promise.all([this.request(`configs/${config}`),this.request(`datasets/${dataset}`),this.request(`judges/${judge}`)]);
    const outputs=[];
    for(const variation of configuration.variations) for(const row of data.rows) {
      // Offline tests use pinned config/dataset/judge versions and never create live outcomes.
      const {customize}=await import('./runtime-schema.js');
      const resolved={configuration:customize(variation,{...(row.variables ?? {}),input:row.input}),mode:configuration.mode,judge:criterion,sampled:true};
      const provider=executor ?? this.providers[variation.provider];if(!provider)throw new Error(`Register an adapter for ${variation.provider}.`);
      const generated=await bounded(signal=>provider({...resolved,input:row.input,context,signal,offline:true}),this.timeoutMs);
      if(typeof generated?.output!=='string')throw new Error('Benchmark adapter must return output text.');
      const judgement=await this.judge(resolved,row.input,generated.output,row.expected);
      outputs.push({rowId:row.id,variation:variation.id,output:generated.output,judgement});
    }
    return this.request('benchmarks','POST',{config,configVersion:configuration.version,dataset,datasetVersion:data.version,judge,judgeVersion:criterion.version,outputs});
  }
  async runGraph(key,{context,variables={},input,executor,selectEdge,maxSteps,handoff,state={}}) {
    if(!state||typeof state!=='object'||JSON.stringify(state).length>16000)throw new Error('Graph state must be an object up to 16 KB.');
    const graph=await this.request(`graphs/${encodeURIComponent(key)}/resolve`,'POST',{context,variables});
    const limit=Math.min(graph.maxSteps,maxSteps ?? graph.maxSteps);
    if(!Number.isInteger(limit)||limit<1)throw new Error('Graph step limit must be a positive integer.');
    const visits=[];let nodeId=graph.root,currentInput=input;
    for(let step=0;step<limit;step++) {
      const node=graph.nodes.find(n=>n.id===nodeId);if(!node)throw new Error('Graph node missing.');
      // Fresh tracking IDs per visit, including cyclic visits; topology stays pinned to this graph version.
      const resolved=step===0?node.resolved:await this.request(`graphs/${encodeURIComponent(key)}/visit`,'POST',{graphTraceId:graph.traceId,nodeId:node.id});
      const nodeExecutor=executor?args=>executor({...args,node:node.id,handoffState:state}):undefined;
      const result=await this.attempt(resolved,{input:currentInput,executor:nodeExecutor});visits.push({node:node.id,...result});
      if(result.error)return {traceId:graph.traceId,graphVersion:graph.version,state,status:'failed',visits,output:null};
      const edges=graph.edges.filter(e=>e.from===node.id);
      if(!edges.length)return {traceId:graph.traceId,graphVersion:graph.version,state,status:'succeeded',visits,output:result.output};
      const next=selectEdge?await selectEdge({node:node.id,edges,output:result.output,visits,state}):edges[0].to;
      if(next===null)return {traceId:graph.traceId,graphVersion:graph.version,state,status:'succeeded',visits,output:result.output};
      if(!edges.some(e=>e.to===next))throw new Error('Selected handoff is not an edge in this graph.');
      if(handoff){const payload=await handoff({from:node.id,to:next,output:result.output,state,visits});if(!payload||typeof payload.input!=='string'||payload.input.length>8000||!payload.state||typeof payload.state!=='object'||JSON.stringify(payload.state).length>16000)throw new Error('Handoff requires input up to 8000 characters and state up to 16 KB.');currentInput=payload.input;state=structuredClone(payload.state);}else currentInput=result.output;
      nodeId=next;
    }
    return {traceId:graph.traceId,graphVersion:graph.version,state,status:'step_limit',visits,output:visits.at(-1)?.output ?? null};
  }
  async verifiedSnapshot() {
    if(!this.trustedPublicKey)throw new Error('Pin the server public key before verifying snapshots.');
    const snapshot=await this.request('snapshot');
    if(!verify(null,Buffer.from(snapshot.payload),this.trustedPublicKey,Buffer.from(snapshot.signature,'base64')))throw new Error('Invalid snapshot signature.');
    const payload=JSON.parse(snapshot.payload);
    if(payload.environment!==this.environment||(this.tenant&&payload.tenant!==this.tenant))throw new Error('Snapshot scope does not match this client.');
    if(payload.environment!==this.environment || payload.expiresAt<=Date.now() || payload.issuedAt>Date.now()+5000)throw new Error('Snapshot is expired or belongs to another environment.');
    return payload;
  }
}

