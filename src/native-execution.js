import { invokeTool,validateToolSchema } from './tool-execution.js';
import { ProviderUsage } from './provider-usage.js';

export function nativeOptions({configuration,attachments=[],toolHandlers={},approvedTools=[]}){
  const parameters=configuration.parameters??{},max=parameters.max_output_tokens??parameters.max_tokens??1024;
  if(!Number.isInteger(max)||max<1||max>4096)throw new Error('Native adapter output token limit must be 1–4096.');
  if(!Array.isArray(attachments)||attachments.length>3)throw new Error('Use at most three bounded images.');
  const images=attachments.map(image=>{const match=/^data:(image\/(png|jpeg|webp));base64,([a-zA-Z0-9+/]+=*)$/.exec(image?.data??'');if(!match||image.data.length>700000)throw new Error('Use PNG, JPEG or WebP images up to 500 KB.');return {mimeType:match[1],format:match[2],data:match[3]};});
  if(!Array.isArray(approvedTools)||approvedTools.length>30||approvedTools.some(name=>typeof name!=='string'))throw new Error('Approved tools must be a bounded array.');
  const definitions=configuration.toolDefinitions??[];
  if(!Array.isArray(definitions)||definitions.length>30)throw new Error('Use at most 30 registered tools.');
  for(const definition of definitions){validateToolSchema(definition.inputSchema);if(!Object.hasOwn(toolHandlers,definition.key)||typeof toolHandlers[definition.key]!=='function')throw new Error(`Register a handler for ${definition.key}.`);if(definition.requiresApproval&&!approvedTools.includes(definition.key))throw new Error(`Approve ${definition.key} before generation.`);}
  return {max,parameters,images,definitions};
}
export async function* providerEvents(response){
  if(!response.ok)throw Object.assign(new Error(`Model provider request failed (${response.status}).`),{status:response.status});
  if(!response.body)throw new Error('Provider returned no stream.');
  const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',total=0;
  try{while(true){const {value,done}=await reader.read();if(value)total+=value.length;if(total>4000000)throw new Error('Provider stream exceeds 4 MB.');buffer=(buffer+decoder.decode(value,{stream:!done})).replace(/\r\n/g,'\n');if(buffer.length>2000000)throw new Error('Provider stream frame is too large.');let at;while((at=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,at);buffer=buffer.slice(at+2);const data=frame.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');if(data&&data!=='[DONE]')yield JSON.parse(data);}if(done){if(buffer.trim())throw new Error('Provider stream ended within a frame.');break;}}}finally{await reader.cancel();}
}
async function request(fetchImpl,url,headers,body,signal){
  const response=await fetchImpl(url,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body),signal});
  if(!response.ok)throw Object.assign(new Error(`Model provider request failed (${response.status}).`),{status:response.status});
  return response;
}
async function anthropicStream(response,onText){
  let result={content:[],usage:{}},stopped=false;const partial=new Map();
  for await(const event of providerEvents(response)){
    if(event.type==='error')throw new Error('Anthropic stream failed.');
    if(event.type==='message_start')result={...event.message,content:[],usage:event.message.usage??{}};
    if(event.type==='content_block_start'){if(!Number.isInteger(event.index)||event.index<0||event.index>100)throw new Error('Invalid stream block index.');result.content[event.index]=structuredClone(event.content_block);}
    if(event.type==='content_block_delta'){
      const block=result.content[event.index];if(!block)throw new Error('Stream delta has no content block.');
      if(event.delta.type==='text_delta'){block.text=(block.text??'')+event.delta.text;await onText(event.delta.text);}
      if(event.delta.type==='input_json_delta')partial.set(event.index,(partial.get(event.index)??'')+event.delta.partial_json);
      if(event.delta.type==='thinking_delta')block.thinking=(block.thinking??'')+event.delta.thinking;
      if(event.delta.type==='signature_delta')block.signature=(block.signature??'')+event.delta.signature;
    }
    if(event.type==='content_block_stop'&&partial.has(event.index))result.content[event.index].input=JSON.parse(partial.get(event.index));
    if(event.type==='message_delta'){result={...result,...event.delta,usage:{...result.usage,...event.usage}};}
    if(event.type==='message_stop')stopped=true;
  }
  if(!stopped||result.stop_reason==='max_tokens')throw new Error('Anthropic stream did not complete.');return result;
}
async function geminiStream(response,onText){
  const parts=[];let usageMetadata={},finishReason;
  for await(const event of providerEvents(response)){
    if(event.error||event.promptFeedback?.blockReason)throw new Error('Gemini stream failed or was blocked.');
    const candidate=event.candidates?.[0];
    for(const part of candidate?.content?.parts??[]){parts.push(part);if(part.text&&!part.thought)await onText(part.text);}
    if(candidate?.finishReason)finishReason=candidate.finishReason;
    if(event.usageMetadata)usageMetadata=event.usageMetadata;
  }
  if(finishReason!=='STOP')throw new Error('Gemini stream did not complete.');return {candidates:[{content:{role:'model',parts},finishReason}],usageMetadata};
}
export async function executeNative({provider,apiKey,fetchImpl=fetch,...options}){
  const {configuration,input,signal,onEvent,toolHandlers={},approvedTools=[]}=options;
  const {max,parameters,images,definitions}=nativeOptions(options);
  const prompts=[...(configuration.messages??[{role:'system',content:configuration.instructions??''}]),{role:'user',content:String(input??'')}];
  const system=prompts.filter(m=>m.role==='system').map(m=>m.content);
  const history=prompts.filter(m=>m.role!=='system').map(m=>provider==='anthropic'?{role:m.role,content:m.content}:{role:m.role==='assistant'?'model':'user',parts:[{text:m.content}]});
  if(images.length){if(provider==='anthropic')history.at(-1).content=[{type:'text',text:String(input??'')},...images.map(image=>({type:'image',source:{type:'base64',media_type:image.mimeType,data:image.data}}))];else history.at(-1).parts.push(...images.map(image=>({inlineData:{mimeType:image.mimeType,data:image.data}})));}
  const toolCalls=[],usage=new ProviderUsage();let firstTokenMs,providerCalls=0,totalOutput=0;const start=performance.now();
  const onText=async text=>{totalOutput+=text.length;if(totalOutput>100000)throw new Error('Generated text exceeds its limit.');firstTokenMs??=performance.now()-start;await onEvent?.({type:'delta',text});};
  for(let turn=0;turn<6;turn++){
    signal?.throwIfAborted();providerCalls++;
    let result,content,calls,output;
    if(provider==='anthropic'){
      const body={model:configuration.model,max_tokens:max,system:system.join('\n'),messages:history,...(onEvent?{stream:true}:{}),...(parameters.temperature!==undefined?{temperature:parameters.temperature}:{}),...(parameters.top_p!==undefined?{top_p:parameters.top_p}:{}),...(definitions.length?{tools:definitions.map(d=>({name:d.key,description:d.description,input_schema:d.inputSchema}))}:{})};
      const response=await request(fetchImpl,'https://api.anthropic.com/v1/messages',{'x-api-key':apiKey,'anthropic-version':'2023-06-01'},body,signal);
      result=onEvent?await anthropicStream(response,onText):await response.json();
      if(result.stop_reason==='max_tokens'||result.type==='error')throw new Error('Anthropic response did not complete.');
      content=result.content??[];calls=content.filter(c=>c.type==='tool_use').map(c=>({name:c.name,id:c.id,args:c.input}));output=content.filter(c=>c.type==='text').map(c=>c.text).join('');
      usage.add(result.usage?.input_tokens,result.usage?.output_tokens);
    }else{
      const body={systemInstruction:{parts:system.map(text=>({text}))},contents:history,generationConfig:{maxOutputTokens:max,...(parameters.temperature!==undefined?{temperature:parameters.temperature}:{}),...(parameters.top_p!==undefined?{topP:parameters.top_p}:{})},...(definitions.length?{tools:[{functionDeclarations:definitions.map(d=>({name:d.key,description:d.description,parametersJsonSchema:d.inputSchema}))}]}:{})};
      const action=onEvent?'streamGenerateContent?alt=sse':'generateContent';
      const response=await request(fetchImpl,`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(configuration.model.replace(/^models\//,''))}:${action}`,{'x-goog-api-key':apiKey},body,signal);
      result=onEvent?await geminiStream(response,onText):await response.json();
      if(result.promptFeedback?.blockReason||result.candidates?.[0]?.finishReason&&result.candidates[0].finishReason!=='STOP')throw new Error('Gemini response did not complete.');
      content=result.candidates?.[0]?.content?.parts??[];calls=content.filter(c=>c.functionCall).map(c=>({name:c.functionCall.name,id:c.functionCall.id,args:c.functionCall.args}));output=content.filter(c=>c.text&&!c.thought).map(c=>c.text).join('');
      usage.add(result.usageMetadata?.promptTokenCount,result.usageMetadata?.candidatesTokenCount);
    }
    if(!onEvent&&output)await onText(output);
    if(!calls.length){if(!output)throw new Error('Provider returned no text output.');return {output,...usage.metrics(configuration.pricing),providerCalls,toolCalls,...(firstTokenMs!==undefined?{firstTokenMs}:{})};}
    if(toolCalls.length+calls.length>10)throw new Error('Tool loop exceeds ten calls.');
    history.push(provider==='anthropic'?{role:'assistant',content}:{role:'model',parts:content});
    const results=[];
    for(const call of calls){const definition=definitions.find(d=>d.key===call.name),started=performance.now();if(!definition)throw new Error('Provider requested an unregistered tool.');const output=await invokeTool(definition,call.args,{handlers:toolHandlers,approvedTools,signal});toolCalls.push({name:call.name,version:definition.version,callId:call.id??`${turn}-${toolCalls.length}`,latencyMs:performance.now()-started,success:true});results.push(provider==='anthropic'?{type:'tool_result',tool_use_id:call.id,content:output}:{functionResponse:{name:call.name,...(call.id?{id:call.id}:{}),response:{result:JSON.parse(output)}}});}
    history.push(provider==='anthropic'?{role:'user',content:results}:{role:'user',parts:results});
  }
  throw new Error('Tool execution exceeded six model turns.');
}
