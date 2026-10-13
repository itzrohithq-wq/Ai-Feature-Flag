import { validateToolSchema } from './tool-execution.js';
export const resourceKinds = ['configs', 'datasets', 'judges', 'graphs', 'models', 'tools', 'segments', 'snippets'];
export const fail = (message, code = 'INVALID_RESOURCE', status = 400) => { throw Object.assign(new Error(message), { status, code }); };
export const keyValid = key => typeof key === 'string' && /^[a-z][a-z0-9-]{1,63}$/.test(key);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 16000) => typeof value === 'string' && value.length <= max;
const range = (value, min, max) => Number.isFinite(value) && value >= min && value <= max;
export function validateResource(kind, input) {
  if (!resourceKinds.includes(kind) || !object(input) || !keyValid(input.key)) fail('Choose a resource type and a lowercase key of 2–64 characters.');
  const result = structuredClone(input);
  delete result.expectedVersion; delete result.version; delete result.updatedAt;
  if (JSON.stringify(result).length > (kind==='datasets'?4000000:60000)) fail('Resource exceeds its size limit (datasets 4 MB, other resources 60 KB).');
  if (kind === 'configs') {
    if (!['completion', 'agent'].includes(result.mode) || typeof result.enabled !== 'boolean') fail('Configs require a mode and Boolean enabled value.');
    if (!Array.isArray(result.variations) || result.variations.length < 1 || result.variations.length > 20) fail('Configs require 1–20 variations.');
    const ids = result.variations.map(v => v?.id);
    if (ids.some(id => !keyValid(id)) || new Set(ids).size !== ids.length || !ids.includes(result.defaultVariation)) fail('Use unique variation IDs and an existing defaultVariation.');
    for (const variation of result.variations) {
      if (!['openai', 'anthropic', 'gemini', 'bedrock', 'custom'].includes(variation.provider) || !text(variation.model, 128) || !variation.model) fail('Each variation requires a provider and model identifier.');
      if (!range(variation.weight, 0, 100)) fail('Variation weights must be between 0 and 100.');
      if (!object(variation.parameters ?? {})) fail('Model parameters must be an object.');
      if (Object.keys(variation.parameters ?? {}).some(k => /key|token|secret|password|credential/i.test(k) && !['max_tokens', 'max_output_tokens', 'max_completion_tokens'].includes(k))) fail('Store provider credentials in your application, not model parameters.');
      if (result.mode === 'agent' && !text(variation.instructions)) fail('Agent variations require instructions.');
      if (result.mode === 'completion' && (!Array.isArray(variation.messages) || variation.messages.length < 1 || variation.messages.length > 20 || variation.messages.some(m => !object(m) || !['system','user','assistant'].includes(m.role) || !text(m.content)))) fail('Completion variations require messages with valid roles and text.');
      if (variation.tools !== undefined && (!Array.isArray(variation.tools) || variation.tools.length > 30 || variation.tools.some(t => !keyValid(t)))) fail('Tools must be registered application tool names.');
      if(variation.pricing && (!object(variation.pricing)||!range(variation.pricing.inputPerMillion,0,1000000)||!range(variation.pricing.outputPerMillion,0,1000000)))fail('Pricing needs nonnegative inputPerMillion and outputPerMillion rates.');
    }
    if (Math.abs(result.variations.reduce((s,v) => s + v.weight, 0) - 100) > 0.000001) fail('Variation weights must total 100.');
    if (!Array.isArray(result.rules ?? []) || (result.rules ?? []).length > 30) fail('Use at most 30 targeting rules.');
    for (const rule of result.rules ?? []) {
      if(rule?.segment){if(!keyValid(rule.segment)||!ids.includes(rule.variation))fail('Segment targeting requires a registered segment and existing variation.');continue;}
      if (!object(rule) || !ids.includes(rule.variation) || !text(rule.attribute, 64) || !rule.attribute || !['eq','in','gte','lte','contains'].includes(rule.operator)) fail('Targeting rules need an attribute, supported operator, and variation.');
      if (rule.operator === 'in' ? (!Array.isArray(rule.value) || rule.value.length > 100 || rule.value.some(v => !['string','number','boolean'].includes(typeof v))) : !['string','number','boolean'].includes(typeof rule.value)) fail('Targeting values must be primitive values or an array for in.');
    }
    if (result.judge !== undefined && !keyValid(result.judge)) fail('Judge must be a registered judge key.');
    if(result.judges!==undefined&&(!Array.isArray(result.judges)||!result.judges.length||result.judges.length>5||result.judges.some(j=>!keyValid(j))||new Set(result.judges).size!==result.judges.length))fail('Attach 1–5 unique registered judges.');
    if(result.experiment){const e=result.experiment;if(e.metric!==undefined&&!['quality','reward','satisfaction','errorRate'].includes(e.metric))fail('Experiment metric must be bounded quality, reward, satisfaction or errorRate.');if(e.baseline!==undefined&&!ids.includes(e.baseline))fail('Experiment baseline must be an existing variation.');if(e.alpha!==undefined&&!range(e.alpha,.001,.2))fail('Experiment alpha must be .001–.2.');if(e.minSamples!==undefined&&(!Number.isInteger(e.minSamples)||!range(e.minSamples,2,10000)))fail('Experiment minSamples must be 2–10000.');}
    if(result.experiment?.holdoutPercent!==undefined&&!range(result.experiment.holdoutPercent,0,50))fail('Holdout percentage must be 0–50.');
    if (!range(result.sampleRate ?? 1, 0, 1)) fail('Online evaluation sampleRate must be between 0 and 1.');
    if (result.experiment && (!object(result.experiment) || !['ab','bandit'].includes(result.experiment.mode) || !range(result.experiment.epsilon ?? .1, .01, .5))) fail('Experiment mode must be ab or bandit; epsilon must be 0.01–0.5.');
    if(result.experiment?.autoPromote!==undefined&&(typeof result.experiment.autoPromote!=='boolean'||result.experiment.autoPromote&&result.experiment.mode!=='ab'))fail('Automatic winner promotion is available for fixed A/B experiments only.');
    if (result.guard) {
      const g = result.guard;
      if (!object(g) || !Number.isInteger(g.minSamples) || !range(g.minSamples, 2, 10000) || !range(g.windowSeconds, 10, 86400) || !['pause','rollback'].includes(g.action)) fail('Guard requires minSamples 2–10000, windowSeconds 10–86400, and pause/rollback action.');
      if (g.minQuality !== undefined && !range(g.minQuality, 0, 1)) fail('minQuality must be 0–1.');
      for (const metric of ['maxLatencyMs','maxCostUsd']) if (g[metric] !== undefined && !range(g[metric], 0, 1000000)) fail(`${metric} must be nonnegative.`);
      if (g.maxErrorRate !== undefined && !range(g.maxErrorRate, 0, 1)) fail('maxErrorRate must be 0–1.');
      if (Object.keys(g).filter(k => ['minQuality','maxLatencyMs','maxCostUsd','maxErrorRate'].includes(k)).length === 0) fail('Choose at least one guard threshold.');
      if (g.action === 'rollback' && (!Number.isInteger(g.rollbackVersion) || g.rollbackVersion < 1)) fail('Rollback guard needs a previous rollbackVersion.');
      if(g.statistical){const s=g.statistical;if(!object(s)||!ids.includes(s.baseline)||!ids.includes(s.candidate)||s.baseline===s.candidate||!['quality','reward','satisfaction','errorRate'].includes(s.metric)||!range(s.alpha??.05,.001,.2)||!range(s.tolerance??0,0,1))fail('Statistical guard needs distinct existing baseline/candidate, bounded metric, alpha and tolerance.');}
      if(g.maxWaitSeconds!==undefined&&!range(g.maxWaitSeconds,10,86400))fail('Guard maxWaitSeconds must be 10–86400.');
    }
    if (result.trigger) {
      const t = result.trigger;
      if (!object(t) || !ids.includes(t.variation) || !Number.isInteger(t.minSamples) || !range(t.minSamples, 2, 10000) || !range(t.windowSeconds, 10, 86400) || !['errorRate','quality','latencyMs','costUsd'].includes(t.metric) || !range(t.threshold, 0, ['quality','errorRate'].includes(t.metric) ? 1 : 1000000)) fail('Adaptive trigger requires a valid metric, threshold, minimum samples, window and destination variation.');
      for(const field of ['delaySeconds','cooldownSeconds'])if(t[field]!==undefined&&!range(t[field],0,86400))fail('Trigger delays must be 0–86400 seconds.');
    }
    if (result.experiment && (result.guard || result.trigger || result.progressive)) fail('Experiments cannot run with guards, triggers, or progressive rollouts.');
    if (result.progressive) {
      const p = result.progressive;
      if (!object(p) || !ids.includes(p.variation) || p.variation === result.defaultVariation || !Array.isArray(p.steps) || !p.steps.length || p.steps.length > 10 || p.steps.some((v,i) => !range(v,1,100) || (i && v <= p.steps[i-1])) || p.steps.at(-1) !== 100 || !range(p.intervalSeconds, 1, 86400) || !Number.isInteger(p.minSamples) || !range(p.minSamples,2,10000)) fail('Progressive rollout needs an existing candidate, increasing steps ending at 100, intervalSeconds, and minSamples.');
    }
    if (result.retry) {
      if (!object(result.retry) || !ids.includes(result.retry.variation) || !range(result.retry.minQuality,0,1)) fail('Retry policy requires a fallback variation and minQuality 0–1.');
    }
  } else if(kind==='snippets'){
    if(!text(result.content)||!result.content.trim()||!text(result.description??'',1000))fail('Prompt snippets require nonempty content up to 16000 characters and an optional description.');
  } else if(kind==='segments'){
    for(const field of ['includedUsers','excludedUsers'])if(!Array.isArray(result[field]??[])||(result[field]??[]).length>1000||(result[field]??[]).some(v=>typeof v!=='string'||!v||v.length>128))fail('Segment membership must be up to 1000 bounded user IDs.');
    if(!Array.isArray(result.rules??[])||(result.rules??[]).length>50)fail('Segments support at most 50 attribute rules.');
    for(const r of result.rules??[]){if(!object(r)||!text(r.attribute,64)||!r.attribute||!['eq','in','gte','lte','contains'].includes(r.operator)|| (r.operator==='in'?(!Array.isArray(r.value)||r.value.length>100||r.value.some(v=>!['string','number','boolean'].includes(typeof v))):!['string','number','boolean'].includes(typeof r.value)))fail('Segment rules need an attribute, operator and primitive value.');}
  } else if (kind === 'datasets') {
    if (!Array.isArray(result.rows) || result.rows.length < 1 || result.rows.length > 1000 || result.rows.some(r => !object(r) || !text(r.input, 8000) || !text(r.expected, 8000) || !text(r.id,128) || !r.id)) fail('Datasets require 1–1000 rows with unique id, input, and expected text.');
    if (new Set(result.rows.map(r => r.id)).size !== result.rows.length) fail('Dataset row IDs must be unique.');
    if(result.rows.some(r=>r.tags!==undefined&&(!Array.isArray(r.tags)||r.tags.length>10||r.tags.some(t=>!text(t,64)||!t))))fail('Dataset tags must be up to 10 nonempty strings of at most 64 characters.');
  } else if (kind === 'judges') {
    if (!['exact','contains','llm'].includes(result.type) || !text(result.description ?? '', 1000)) fail('Judge type must be exact, contains, or llm.');
    if (result.type === 'llm' && (!text(result.prompt, 16000) || !result.prompt || !text(result.model,128) || !result.model || !['openai','anthropic','gemini','bedrock','custom'].includes(result.provider))) fail('LLM judges require a rubric prompt, provider and model.');
  } else if (kind === 'models') {
    if(!['openai','anthropic','gemini','bedrock','custom'].includes(result.provider) || !text(result.model,128) || !result.model || !object(result.parameters ?? {})) fail('Model profiles require a provider, model identifier, and parameters object.');
    if(Object.keys(result.parameters ?? {}).some(k=>/key|secret|password|credential/i.test(k))) fail('Provider credentials must remain in your application.');
  } else if (kind === 'tools') {
    if(!text(result.description,2000) || !object(result.inputSchema) || result.inputSchema.type!=='object') fail('Tools require a description and an object inputSchema.');
    if(typeof result.requiresApproval!=='boolean') fail('Tool requiresApproval must be Boolean.');
    validateToolSchema(result.inputSchema);
  } else if (kind === 'graphs') {
    if (!Array.isArray(result.nodes) || !result.nodes.length || result.nodes.length > 30 || result.nodes.some(n => !object(n) || !keyValid(n.id) || !keyValid(n.config))) fail('Graphs require 1–30 nodes with id and config key.');
    const ids = result.nodes.map(n => n.id);
    if (new Set(ids).size !== ids.length || !ids.includes(result.root)) fail('Graph root must name a unique node.');
    if (!Array.isArray(result.edges) || result.edges.length > 100 || result.edges.some(e => !object(e) || !ids.includes(e.from) || !ids.includes(e.to))) fail('Graph edges must reference existing nodes.');
    if (!Number.isInteger(result.maxSteps) || !range(result.maxSteps,1,100)) fail('Graph execution needs a maxSteps limit of 1–100.');
    const reachable = new Set([result.root]); let changed = true;
    while(changed) { changed = false; for(const edge of result.edges) if(reachable.has(edge.from) && !reachable.has(edge.to)) { reachable.add(edge.to); changed = true; } }
    if (reachable.size !== ids.length) fail('Every graph node must be reachable from its root.');
  }
  return result;
}

export function matches(rule, context) {
  if(rule.segmentDefinition){const segment=rule.segmentDefinition;if(segment.excludedUsers?.includes(context.userId))return false;return segment.includedUsers?.includes(context.userId)||(segment.rules??[]).some(r=>matches(r,context));}
  const actual = Object.hasOwn(context.attributes ?? {}, rule.attribute) ? context.attributes[rule.attribute] : (['userId','cohort'].includes(rule.attribute) ? context[rule.attribute] : undefined);
  if (rule.operator === 'eq') return actual === rule.value;
  if (rule.operator === 'in') return rule.value.includes(actual);
  if (rule.operator === 'gte') return typeof actual === 'number' && actual >= rule.value;
  if (rule.operator === 'lte') return typeof actual === 'number' && actual <= rule.value;
  return typeof actual === 'string' && actual.includes(String(rule.value));
}

export function customize(variation, variables = {}) {
  const replace = value => value.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, name) => {
    if (!Object.hasOwn(variables,name) || !['string','number','boolean'].includes(typeof variables[name])) fail(`Missing prompt variable: ${name}`, 'MISSING_VARIABLE');
    return String(variables[name]);
  });
  return { ...variation, ...(variation.messages ? { messages: variation.messages.map(m => ({ ...m, content: replace(m.content) })) } : {}), ...(variation.instructions !== undefined ? { instructions: replace(variation.instructions) } : {}) };
}

export function scoreJudge(judge, input, output, expected) {
  if (judge.type === 'llm') return null;
  if (typeof expected !== 'string') fail('This deterministic judge requires expected text.', 'EXPECTED_REQUIRED');
  const passed = judge.type === 'exact' ? output.trim() === expected.trim() : output.toLowerCase().includes(expected.toLowerCase());
  return { score: passed ? 1 : 0, reason: `${judge.type} comparison ${passed ? 'passed' : 'failed'}`, source: 'deterministic' };
}

