function normalize(message) {
  const output=typeof message?.content==='string'?message.content:(message?.content ?? []).filter(block=>block.type==='text').map(block=>block.text).join('');
  if(!output)throw new Error('Framework returned no text output.');
  const usage=message.usage_metadata;
  return {output,...(usage?{inputTokens:usage.input_tokens,outputTokens:usage.output_tokens}:{})};
}
function inputs(configuration,input) {
  return [...(configuration.messages ?? [{role:'system',content:configuration.instructions ?? ''}]),{role:'user',content:String(input ?? '')}];
}

// buildRunnable is owned by the integrating app: it selects credentials, tools,
// and the actual LangChain model/agent using the resolved runtime config.
export function langChainExecutor({buildRunnable}) {
  return async({configuration,input,signal})=>{
    const runnable=await buildRunnable(configuration);
    const result=await runnable.invoke(inputs(configuration,input),{signal});
    return normalize(result);
  };
}

// A compiled LangGraph graph remains app-owned. Its model node reads the config
// from configurable.runtimeConfiguration instead of hard-coded prompts/models.
export function langGraphExecutor({graph}) {
  return async({configuration,input,signal})=>{
    const state=await graph.invoke({messages:inputs(configuration,input)},{signal,configurable:{runtimeConfiguration:configuration}});
    return normalize(state.messages?.at(-1));
  };
}
