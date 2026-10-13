import { ConverseCommand, ConverseStreamCommand } from '@aws-sdk/client-bedrock-runtime';
import { nativeOptions } from './native-execution.js';
import { invokeTool } from './tool-execution.js';
import { ProviderUsage } from './provider-usage.js';

export async function executeBedrock(runtime,options){
  const {configuration,input,signal,onEvent,toolHandlers={},approvedTools=[]}=options;
  const {max,parameters,images,definitions}=nativeOptions(options);
  const prompts=[...(configuration.messages??[{role:'system',content:configuration.instructions??''}]),{role:'user',content:String(input??'')}];
  const messages=prompts.filter(m=>m.role!=='system').map(m=>({role:m.role,content:[{text:m.content}]}));
  messages.at(-1).content.push(...images.map(image=>({image:{format:image.format,source:{bytes:Buffer.from(image.data,'base64')}}})));
  const body={modelId:configuration.model,system:prompts.filter(m=>m.role==='system').map(m=>({text:m.content})),messages,inferenceConfig:{maxTokens:max,...(parameters.temperature!==undefined?{temperature:parameters.temperature}:{}),...(parameters.top_p!==undefined?{topP:parameters.top_p}:{})},...(definitions.length?{toolConfig:{tools:definitions.map(d=>({toolSpec:{name:d.key,description:d.description,inputSchema:{json:d.inputSchema}}}))}}:{})};
  let firstTokenMs,totalBytes=0;const started=performance.now(),toolCalls=[],usageTotal=new ProviderUsage();
  const text=async value=>{totalBytes+=value.length;if(totalBytes>100000)throw new Error('Generated text exceeds its limit.');firstTokenMs??=performance.now()-started;await onEvent?.({type:'delta',text:value});};
  for(let turn=0;turn<6;turn++){
    signal?.throwIfAborted();let result=await runtime.send(onEvent?new ConverseStreamCommand(body):new ConverseCommand(body),{abortSignal:signal});
    if(onEvent){
      const blocks=[],inputs=new Map();let stopReason,usage={},events=0;
      for await(const event of result.stream){
        signal?.throwIfAborted();if(++events>50000)throw new Error('Provider stream exceeds its event limit.');
        if(Object.keys(event).some(key=>key.endsWith('Exception')))throw new Error('Bedrock stream failed.');
        if(event.contentBlockStart){const {contentBlockIndex:index,start}=event.contentBlockStart;if(!Number.isInteger(index)||index<0||index>100)throw new Error('Invalid stream block index.');blocks[index]=start.toolUse?{toolUse:{...start.toolUse,input:{}}}:{text:''};}
        if(event.contentBlockDelta){const {contentBlockIndex:index,delta}=event.contentBlockDelta;if(!Number.isInteger(index)||index<0||index>100)throw new Error('Invalid stream block index.');if(delta.text!==undefined){blocks[index]??={text:''};blocks[index].text+=delta.text;await text(delta.text);}if(delta.toolUse){const value=(inputs.get(index)??'')+delta.toolUse.input;if(value.length>16000)throw new Error('Tool input exceeds its limit.');inputs.set(index,value);}}
        if(event.contentBlockStop&&inputs.has(event.contentBlockStop.contentBlockIndex)){const index=event.contentBlockStop.contentBlockIndex;if(!blocks[index]?.toolUse)throw new Error('Tool stream has no start block.');blocks[index].toolUse.input=JSON.parse(inputs.get(index));}
        if(event.messageStop)stopReason=event.messageStop.stopReason;if(event.metadata)usage=event.metadata.usage??usage;
      }
      if(!['end_turn','tool_use','stop_sequence'].includes(stopReason))throw new Error('Bedrock stream did not complete.');result={output:{message:{role:'assistant',content:blocks}},usage,stopReason};
    }
    if(result.stopReason&&!['end_turn','tool_use','stop_sequence'].includes(result.stopReason))throw new Error('Bedrock response did not complete.');
    const content=result.output?.message?.content??[],output=content.filter(c=>c.text).map(c=>c.text).join(''),calls=content.filter(c=>c.toolUse).map(c=>c.toolUse);
    usageTotal.add(result.usage?.inputTokens,result.usage?.outputTokens);if(!onEvent&&output)await text(output);
    if(!calls.length){if(!output)throw new Error('Provider returned no text output.');return {output,...usageTotal.metrics(configuration.pricing),firstTokenMs,providerCalls:turn+1,toolCalls};}
    if(toolCalls.length+calls.length>10)throw new Error('Tool loop exceeds ten calls.');messages.push({role:'assistant',content});const results=[];
    for(const call of calls){const definition=definitions.find(d=>d.key===call.name);if(!definition)throw new Error('Provider requested an unregistered tool.');const start=performance.now(),output=await invokeTool(definition,call.input,{handlers:toolHandlers,approvedTools,signal});toolCalls.push({name:call.name,version:definition.version,callId:call.toolUseId,latencyMs:performance.now()-start,success:true});results.push({toolResult:{toolUseId:call.toolUseId,content:[{json:JSON.parse(output)}],status:'success'}});}
    messages.push({role:'user',content:results});
  }
  throw new Error('Tool execution exceeded six model turns.');
}
