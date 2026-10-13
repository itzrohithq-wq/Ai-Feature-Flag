import { invokeTool,validateToolSchema } from './tool-execution.js';
import { ProviderUsage } from './provider-usage.js';

async function streamResponse(response, onEvent) {
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '', completed;
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, '\n');
      if (buffer.length > 2_000_000) throw new Error('Provider stream frame exceeds its limit.');
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        const payload = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!payload || payload === '[DONE]') continue;
        const event = JSON.parse(payload);
        if (event.type === 'response.output_text.delta') await onEvent?.({ type: 'delta', text: event.delta });
        if (['error', 'response.failed', 'response.incomplete'].includes(event.type)) throw new Error('Provider could not complete the stream.');
        if (event.type === 'response.completed') completed = event.response;
      }
      if (done) break;
    }
  } finally { await reader.cancel(); }
  if (!completed) throw new Error('Provider stream ended without a completed response.');
  return completed;
}

export async function executeOpenAI({ apiKey, fetchImpl, configuration, input, signal, onEvent, attachments = [], toolHandlers = {}, approvedTools = [] }) {
  const parameters = configuration.parameters ?? {};
  if(!Array.isArray(approvedTools)||approvedTools.length>30||approvedTools.some(name=>typeof name!=='string'))throw new Error('Approved tools must be a bounded list of tool names.');
  const max = parameters.max_output_tokens ?? parameters.max_tokens ?? 1024;
  if (!Number.isInteger(max) || max < 1 || max > 4096) throw new Error('Native adapter output token limit must be 1–4096.');
  if (!Array.isArray(attachments) || attachments.length > 3 || attachments.some(a => !/^data:image\/(png|jpeg|webp);base64,[a-zA-Z0-9+/]+=*$/.test(a?.data ?? '') || a.data.length > 700000)) throw new Error('Use at most three PNG, JPEG or WebP image attachments, each up to 500 KB.');
  const content = attachments.length ? [{ type: 'input_text', text: String(input ?? '') }, ...attachments.map(a => ({ type: 'input_image', image_url: a.data, detail: 'auto' }))] : String(input ?? '');
  const conversation = [...(configuration.messages ?? [{ role: 'system', content: configuration.instructions ?? '' }]), { role: 'user', content }];
  const definitions = configuration.toolDefinitions ?? [];
  // Check all handlers and approvals before the first billable call.
  for (const definition of definitions) {
    validateToolSchema(definition.inputSchema);
    if (!Object.hasOwn(toolHandlers,definition.key)||typeof toolHandlers[definition.key] !== 'function') throw Object.assign(new Error(`Register a handler for ${definition.key}.`), { status: 409, code: 'TOOL_NOT_CONFIGURED' });
    if (definition.requiresApproval && !approvedTools.includes(definition.key)) throw Object.assign(new Error(`Approve ${definition.key} before running.`), { status: 409, code: 'TOOL_APPROVAL_REQUIRED' });
  }
  const usage=new ProviderUsage();let firstTokenMs, output = '', calls = 0;
  const started = performance.now(), toolCalls = [];
  for (let step = 0; step < 6; step++) {
    const body = { model: configuration.model, input: conversation, max_output_tokens: max, store: false,
      ...(parameters.temperature !== undefined ? { temperature: parameters.temperature } : {}),
      ...(parameters.top_p !== undefined ? { top_p: parameters.top_p } : {}),
      ...(definitions.length ? { tools: definitions.map(d => ({ type: 'function', name: d.key, description: d.description, parameters: d.inputSchema, strict: false })), parallel_tool_calls: false } : {}),
      ...(onEvent ? { stream: true } : {}) };
    const response = await fetchImpl('https://api.openai.com/v1/responses', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, body: JSON.stringify(body), signal });
    calls++;
    if (!response.ok) throw Object.assign(new Error(`Model provider request failed (${response.status}).`), { status: response.status });
    const result = onEvent ? await streamResponse(response, async event => { if (firstTokenMs === undefined) firstTokenMs = performance.now() - started; await onEvent(event); }) : await response.json();
    usage.add(result.usage?.input_tokens,result.usage?.output_tokens);
    const functions = (result.output ?? []).filter(item => item.type === 'function_call');
    output += (result.output ?? []).flatMap(item => item.content ?? []).filter(item => item.type === 'output_text').map(item => item.text).join('');
    if (output.length > 100000) throw new Error('Provider output exceeds its limit.');
    if (!functions.length) {
      if (!output) throw new Error('Provider returned no text output.');
      const completion = { output,...usage.metrics(configuration.pricing), providerCalls: calls, toolCalls, ...(firstTokenMs !== undefined ? { firstTokenMs } : {}) };
      return completion;
    }
    if (step === 5 || toolCalls.length + functions.length > 10) throw new Error('Tool execution reached its bounded call limit.');
    conversation.push(...result.output);
    for (const call of functions) {
      const definition = definitions.find(d => d.key === call.name);
      const toolStarted = performance.now();
      const resultText = await invokeTool(definition, JSON.parse(call.arguments), { handlers: toolHandlers, approvedTools, signal });
      const evidence = { name: call.name, version: definition.version, callId: call.call_id, latencyMs: performance.now() - toolStarted, success: true };
      toolCalls.push(evidence); await onEvent?.({ type: 'tool', ...evidence });
      conversation.push({ type: 'function_call_output', call_id: call.call_id, output: resultText });
    }
  }
}
