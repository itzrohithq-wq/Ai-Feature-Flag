import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openaiAdapter,anthropicAdapter,geminiAdapter,bedrockAdapter,providersFromEnvironment } from '../src/providers.js';

test('native HTTP adapters build provider requests and normalize response usage',async()=>{
  const requests=[];
  const fixture=createServer(async(req,res)=>{let text='';for await(const chunk of req)text+=chunk;requests.push({url:req.url,headers:req.headers,body:JSON.parse(text)});res.setHeader('Content-Type','application/json');
    const result=req.url.includes('responses')?{output:[{content:[{type:'output_text',text:'openai text'}]}],usage:{input_tokens:10,output_tokens:5}}:req.url.includes('messages')?{content:[{type:'text',text:'claude text'}],usage:{input_tokens:10,output_tokens:5}}:{candidates:[{content:{parts:[{text:'gemini text'}]}}],usageMetadata:{promptTokenCount:10,candidatesTokenCount:5}};res.end(JSON.stringify(result));});
  await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
  const fetchImpl=(url,options)=>fetch(`http://127.0.0.1:${fixture.address().port}${new URL(url).pathname}`,options);
  const configuration={model:'test-model',messages:[{role:'system',content:'Be helpful.'}],parameters:{max_tokens:20,temperature:.2},pricing:{inputPerMillion:1,outputPerMillion:2}};
  try{
    const adapters=[openaiAdapter({apiKey:'test-key',fetchImpl}),anthropicAdapter({apiKey:'test-key',fetchImpl}),geminiAdapter({apiKey:'test-key',fetchImpl})];
    for(const adapter of adapters){const result=await adapter({configuration,input:'hello'});assert.equal(result.inputTokens,10);assert.equal(result.outputTokens,5);assert.equal(result.costUsd,.00002);assert.ok(result.output.endsWith('text'));}
    assert.equal(requests[0].body.store,false);assert.equal(requests[0].body.max_output_tokens,20);assert.equal(requests[0].body.input[1].content,'hello');
    assert.equal(requests[1].body.system,'Be helpful.');assert.equal(requests[1].headers['anthropic-version'],'2023-06-01');
    assert.equal(requests[2].body.generationConfig.maxOutputTokens,20);assert.equal(requests[2].headers['x-goog-api-key'],'test-key');
    await assert.rejects(()=>adapters[0]({configuration:{...configuration,parameters:{max_tokens:5000}},input:'hello'}));
    assert.deepEqual(providersFromEnvironment({}),{});
  }finally{await new Promise(resolve=>fixture.close(resolve));}
});
test('Bedrock delegates credential signing and Converse transport to the official AWS SDK',async()=>{
  let sent;
  const adapter=bedrockAdapter({region:'us-east-1',client:{send:async(command)=>{sent=command.input;return{output:{message:{content:[{text:'answer'}]}},usage:{inputTokens:3,outputTokens:2}};}}});
  const result=await adapter({configuration:{model:'test-model',messages:[{role:'system',content:'System'}],parameters:{}},input:'Question'});
  assert.equal(result.output,'answer');assert.equal(sent.modelId,'test-model');assert.equal(sent.messages[0].content[0].text,'Question');
});
