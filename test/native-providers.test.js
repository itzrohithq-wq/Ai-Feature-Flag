import test from 'node:test';import assert from 'node:assert/strict';
import { openaiAdapter,anthropicAdapter,geminiAdapter,bedrockAdapter } from '../src/providers.js';
const definition={key:'calculator',version:1,description:'Add values.',inputSchema:{type:'object',properties:{values:{type:'array',items:{type:'number'}}},required:['values'],additionalProperties:false},requiresApproval:true};
const configuration={model:'fixture',instructions:'Help',parameters:{},tools:['calculator'],toolDefinitions:[definition]};
const options={configuration,input:'Add',attachments:[{data:'data:image/png;base64,aGVsbG8='}],approvedTools:['calculator'],toolHandlers:{calculator:async({values})=>({value:values.reduce((a,b)=>a+b,0)})}};
const sse=events=>new Response(events.map(event=>`data: ${JSON.stringify(event)}\n\n`).join(''),{headers:{'Content-Type':'text/event-stream'}});
const antEvents=content=>[{type:'message_start',message:{usage:{input_tokens:3}}},...content.flatMap((block,index)=>[{type:'content_block_start',index,content_block:block.type==='tool_use'?{...block,input:{}}:{type:'text',text:''}},{type:'content_block_delta',index,delta:block.type==='tool_use'?{type:'input_json_delta',partial_json:JSON.stringify(block.input)}:{type:'text_delta',text:block.text}},{type:'content_block_stop',index}]),{type:'message_delta',delta:{stop_reason:content.some(c=>c.type==='tool_use')?'tool_use':'end_turn'},usage:{output_tokens:2}},{type:'message_stop'}];

for(const streaming of [false,true]){
  test(`Claude native tools, images and ${streaming?'streaming':'JSON'} follow-up`,async()=>{
    const requests=[],events=[];let turn=0;
    const adapter=anthropicAdapter({apiKey:'fixture',fetchImpl:async(url,request)=>{requests.push(JSON.parse(request.body));const content=turn++===0?[{type:'tool_use',id:'tool-1',name:'calculator',input:{values:[2,3]}}]:[{type:'text',text:'Five'}];return streaming?sse(antEvents(content)):Response.json({content,stop_reason:turn===1?'tool_use':'end_turn',usage:{input_tokens:3,output_tokens:2}});}});
    const result=await adapter({...options,...(streaming?{onEvent:event=>events.push(event)}:{})});
    assert.equal(result.output,'Five');assert.equal(result.inputTokens,6);assert.equal(result.providerCalls,2);assert.equal(result.toolCalls.length,1);
    assert.equal(requests[0].messages[0].content[1].source.media_type,'image/png');assert.equal(requests[1].messages.at(-1).content[0].tool_use_id,'tool-1');
    if(streaming)assert.equal(events.map(e=>e.text).join(''),'Five');
  });
  test(`Gemini native tools preserve signatures and ${streaming?'streaming':'JSON'} usage`,async()=>{
    const requests=[],events=[];let turn=0;
    const adapter=geminiAdapter({apiKey:'fixture',fetchImpl:async(url,request)=>{requests.push(JSON.parse(request.body));const parts=turn++===0?[{functionCall:{name:'calculator',id:'call-1',args:{values:[2,3]}},thoughtSignature:'opaque-provider-signature'}]:[{text:'Five'}];const result={candidates:[{content:{role:'model',parts},finishReason:'STOP'}],usageMetadata:{promptTokenCount:3,candidatesTokenCount:2}};return streaming?sse([result]):Response.json(result);}});
    const result=await adapter({...options,...(streaming?{onEvent:event=>events.push(event)}:{})});
    assert.equal(result.output,'Five');assert.equal(result.inputTokens,6);assert.equal(result.outputTokens,4);
    assert.equal(requests[0].contents[0].parts[1].inlineData.mimeType,'image/png');assert.equal(requests[1].contents[1].parts[0].thoughtSignature,'opaque-provider-signature');assert.equal(requests[1].contents[2].parts[0].functionResponse.response.result.value,5);
    if(streaming)assert.equal(events.map(e=>e.text).join(''),'Five');
  });
}
test('native provider validation fails before charges and rejects truncated streams and unsafe tools',async()=>{
  for(const create of [anthropicAdapter,geminiAdapter]){let calls=0;const adapter=create({apiKey:'fixture',fetchImpl:async()=>{calls++;return sse([]);}});await assert.rejects(adapter({...options,approvedTools:[]}),/Approve/);assert.equal(calls,0);await assert.rejects(adapter({...options,attachments:[{data:'https://example.com/image'}]}));assert.equal(calls,0);await assert.rejects(adapter({...options,onEvent:()=>{}}),/did not complete/);}
  const adapter=anthropicAdapter({apiKey:'fixture',fetchImpl:async()=>Response.json({content:[{type:'tool_use',id:'bad',name:'shell',input:{command:'anything'}}]})});await assert.rejects(adapter(options),/unregistered/);
});
test('Bedrock streams bounded approved tools through the signed SDK and rejects incomplete streams',async()=>{
  const requests=[],events=[];let turn=0;
  const adapter=bedrockAdapter({region:'us-east-1',client:{send:async command=>{requests.push(structuredClone(command.input));const isTool=turn++===0;return {stream:(async function*(){if(isTool){yield {contentBlockStart:{contentBlockIndex:0,start:{toolUse:{toolUseId:'tool-1',name:'calculator'}}}};yield {contentBlockDelta:{contentBlockIndex:0,delta:{toolUse:{input:'{"values":[2,3]}'}}}};yield {contentBlockStop:{contentBlockIndex:0}};}else yield {contentBlockDelta:{contentBlockIndex:0,delta:{text:'Five'}}};yield {messageStop:{stopReason:isTool?'tool_use':'end_turn'}};yield {metadata:{usage:{inputTokens:3,outputTokens:2}}};})()};}}});
  const result=await adapter({...options,onEvent:event=>events.push(event)});assert.equal(result.output,'Five');assert.equal(result.inputTokens,6);assert.equal(result.providerCalls,2);assert.equal(requests[0].messages[0].content[1].image.format,'png');assert.equal(requests[1].messages.at(-1).content[0].toolResult.content[0].json.value,5);assert.equal(events.map(e=>e.text).join(''),'Five');
  const broken=bedrockAdapter({region:'us-east-1',client:{send:async()=>({stream:(async function*(){yield {contentBlockDelta:{contentBlockIndex:0,delta:{text:'partial'}}};})()})}});await assert.rejects(broken({...options,onEvent:()=>{}}),/did not complete/);
});
test('missing provider usage stays unknown rather than appearing as free generation',async()=>{
  const configuration={model:'fixture',messages:[{role:'system',content:'Help'}],parameters:{},pricing:{inputPerMillion:1,outputPerMillion:2}};
  const factories=[openaiAdapter,anthropicAdapter,geminiAdapter];const responses=[{output:[{content:[{type:'output_text',text:'Answer'}]}]},{content:[{type:'text',text:'Answer'}]},{candidates:[{content:{parts:[{text:'Answer'}]},finishReason:'STOP'}]}];
  for(let i=0;i<factories.length;i++){const result=await factories[i]({apiKey:'fixture',fetchImpl:async()=>Response.json(responses[i])})({configuration,input:'Question'});assert.equal(result.costUsd,undefined);assert.equal(result.inputTokens,undefined);assert.equal(result.outputTokens,undefined);}
  const result=await bedrockAdapter({region:'us-east-1',client:{send:async()=>({output:{message:{content:[{text:'Answer'}]}}})}})({configuration,input:'Question'});assert.equal(result.costUsd,undefined);
});
test('native tool loops remain bounded and aborted calls never reach the provider',async()=>{
  let calls=0;const adapter=anthropicAdapter({apiKey:'fixture',fetchImpl:async()=>{calls++;return Response.json({content:[{type:'tool_use',id:'repeat-'+calls,name:'calculator',input:{values:[1]}}]});}});
  await assert.rejects(adapter(options),/six model turns/);assert.equal(calls,6);
  const controller=new AbortController();controller.abort();await assert.rejects(adapter({...options,signal:controller.signal}));assert.equal(calls,6);
});
