import { randomUUID } from 'node:crypto';
import { customize, fail } from './runtime-schema.js';
import { RuntimeClient, bounded } from './runtime-sdk.js';
import { builtInTools } from './tool-execution.js';

export async function generate(runtime,providers,tenant,environment,input,{onEvent,signal:outerSignal,toolHandlers=builtInTools}={}) {
  const config=runtime.get(tenant,environment,'configs',input.config,input.configVersion);
  runtime.policies?.enforce(tenant,environment,config);
  if(typeof input.input!=='string'||input.input.length>8000)fail('Playground input must be text of at most 8000 characters.');
  const candidate=config.variations.find(v=>v.id===input.variation);
  if(!candidate)fail('Choose an existing config variation.');
  const provider=providers[candidate.provider];
  if(!provider)fail(`The ${candidate.provider} provider is not configured on this server.`, 'PROVIDER_NOT_CONFIGURED',409);
  if(input.approvedTools!==undefined&&(!Array.isArray(input.approvedTools)||input.approvedTools.length>30||input.approvedTools.some(t=>typeof t!=='string')))fail('Approved tools must be a list of registered tool names.');
  const judges=input.judge?[runtime.get(tenant,environment,'judges',input.judge,input.judgeVersion)]:(config.judges??(config.judge?[config.judge]:[])).map(key=>runtime.get(tenant,environment,'judges',key));
  if(judges.some(j=>j.type==='llm'&&!providers[j.provider]))fail('Configure each attached judge provider before generation.','PROVIDER_NOT_CONFIGURED',409);
  if(input.attachments?.length&&!provider.capabilities?.images)fail('Image input requires a provider with image support.','UNSUPPORTED_CAPABILITY',409);
  if(onEvent&&!provider.capabilities?.streaming)fail('This provider does not support native streaming.','UNSUPPORTED_CAPABILITY',409);
  if(candidate.tools?.length){if(input.allowToolCalls!==true)fail('Explicitly authorize tool execution.','TOOL_APPROVAL_REQUIRED',409);if(!provider.capabilities?.tools)fail('This provider has no native tool support.','UNSUPPORTED_CAPABILITY',409);for(const definition of candidate.toolDefinitions){if(!Object.hasOwn(toolHandlers,definition.key)||typeof toolHandlers[definition.key]!=='function')fail(`Register a server handler for ${definition.key}.`,'TOOL_NOT_CONFIGURED',409);if(definition.requiresApproval&&!input.approvedTools?.includes(definition.key))fail(`Approve ${definition.key} explicitly.`,'TOOL_APPROVAL_REQUIRED',409);}}
  const configuration=customize(candidate,{...(input.variables ?? {}),input:input.input});
  const started=performance.now();
  const completion=await bounded(signal=>provider({configuration,mode:config.mode,input:input.input,signal:outerSignal?AbortSignal.any([signal,outerSignal]):signal,onEvent,attachments:input.attachments??[],toolHandlers,approvedTools:input.approvedTools??[]}),30000);
  if(typeof completion?.output!=='string')fail('Provider returned no text.', 'INVALID_PROVIDER_RESPONSE',502);
  const latencyMs=performance.now()-started;
  let evaluation=null;
  const evaluations=[];
  for(const judge of judges)evaluations.push({judge:judge.key,version:judge.version,...await new RuntimeClient({baseUrl:'',token:'',providers}).judge({judge,sampled:true},input.input,completion.output,input.expected)});
  if(evaluations.length)evaluation=evaluations.length===1?{score:evaluations[0].score,reason:evaluations[0].reason}:{score:evaluations.reduce((sum,e)=>sum+e.score,0)/evaluations.length,reason:'Mean of attached judges'};
  return {id:randomUUID(),timestamp:new Date().toISOString(),type:'playground',config:config.key,configVersion:config.version,variation:candidate.id,provider:candidate.provider,model:candidate.model,output:completion.output,metrics:{latencyMs,...Object.fromEntries(['inputTokens','outputTokens','costUsd','firstTokenMs','providerCalls'].filter(k=>completion[k]!==undefined).map(k=>[k,completion[k]]))},toolCalls:completion.toolCalls??[],attachmentCount:input.attachments?.length??0,evaluations,evaluation,judge:judges[0]?.key ?? null,judgeVersion:judges[0]?.version ?? null};
}

export async function runBenchmark(runtime,providers,tenant,environment,input) {
  const config=runtime.get(tenant,environment,'configs',input.config,input.configVersion);
  const dataset=runtime.get(tenant,environment,'datasets',input.dataset,input.datasetVersion);
  const judge=runtime.get(tenant,environment,'judges',input.judge,input.judgeVersion);
  const variants=input.variations ?? config.variations.map(v=>v.id);
  if(!Array.isArray(variants)||!variants.length||new Set(variants).size!==variants.length||variants.some(v=>!config.variations.some(c=>c.id===v)))fail('Select existing unique variation IDs.');
  if(dataset.rows.length*variants.length>100)fail('Server benchmarks are limited to 100 generation calls. Use a smaller dataset or fewer variations.');
  // Validate provider access and mode before the first billable request.
  if(config.mode!=='completion'||variants.some(id=>{const v=config.variations.find(v=>v.id===id);return !providers[v.provider]||v.tools?.length;}))fail('Configure each selected completion provider; tool execution requires your application.','PROVIDER_NOT_CONFIGURED',409);
  if(judge.type==='llm'&&!providers[judge.provider])fail('Configure the judge provider before running a benchmark.','PROVIDER_NOT_CONFIGURED',409);
  const outputs=[];
  for(const variation of variants)for(const row of dataset.rows){
    const result=await generate(runtime,providers,tenant,environment,{config:config.key,configVersion:config.version,variation,input:row.input,variables:row.variables,expected:row.expected,judge:judge.key,judgeVersion:judge.version});
    outputs.push({rowId:row.id,variation,output:result.output,judgement:result.evaluation});
  }
  return runtime.benchmark(tenant,environment,{config:config.key,configVersion:config.version,dataset:dataset.key,datasetVersion:dataset.version,judge:judge.key,judgeVersion:judge.version,outputs});
}
