import { createHash } from 'node:crypto';

export function validateFlag(flag) {
  const fail = message => { throw Object.assign(new Error(message), { status: 400, code: 'INVALID_FLAG' }); };
  if (!flag || typeof flag !== 'object' || Array.isArray(flag)) fail('Flag must be an object.');
  if (!/^[a-z][a-z0-9-]{1,63}$/.test(flag.key)) fail('Use a key of 2–64 lowercase letters, numbers, or hyphens.');
  if (!['development', 'staging', 'production'].includes(flag.environment)) fail('Choose a valid environment.');
  if (!['boolean', 'multivariate'].includes(flag.type)) fail('Choose boolean or multivariate.');
  if (typeof flag.enabled !== 'boolean') fail('Enabled must be Boolean.');
  if (!Number.isFinite(flag.rollout) || flag.rollout < 0 || flag.rollout > 100) fail('Rollout must be between 0 and 100.');
  if (!Array.isArray(flag.targets) || flag.targets.length > 100 || flag.targets.some(x => typeof x !== 'string' || !x.length || x.length > 128)) fail('Targets must contain at most 100 cohort names.');
  if (flag.type === 'boolean' && (typeof flag.defaultValue !== 'boolean' || typeof flag.value !== 'boolean')) fail('Boolean flags require Boolean values.');
  if (flag.type === 'multivariate') {
    if (typeof flag.defaultValue !== 'string' || flag.defaultValue.length > 256) fail('Default variant must be a string of at most 256 characters.');
    if (!Array.isArray(flag.variants) || flag.variants.length < 2 || flag.variants.length > 20) fail('Supply 2–20 variants.');
    if (flag.variants.some(v => !v || typeof v.value !== 'string' || !v.value.length || v.value.length > 256 || !Number.isFinite(v.weight) || v.weight <= 0)) fail('Each variant needs a name and positive weight.');
    if (new Set(flag.variants.map(v => v.value)).size !== flag.variants.length) fail('Variant names must be unique.');
    if (Math.abs(flag.variants.reduce((s, v) => s + v.weight, 0) - 100) > 0.000001) fail('Variant weights must total 100.');
  }
  return { key: flag.key, environment: flag.environment, type: flag.type, enabled: flag.enabled, rollout: flag.rollout, targets: flag.targets, defaultValue: flag.defaultValue, ...(flag.type === 'boolean' ? { value: flag.value } : { variants: flag.variants.map(v => ({ value: v.value, weight: v.weight })) }) };
}

function bucket(parts) {
  return createHash('sha256').update(JSON.stringify(parts)).digest().readUInt32BE(0) / 4294967296 * 100;
}

export function evaluate(flag, context, tenant) {
  if (!context || typeof context.userId !== 'string' || !context.userId.length || context.userId.length > 128 || (context.cohort !== undefined && (typeof context.cohort !== 'string' || context.cohort.length > 128))) {
    throw Object.assign(new Error('Supply a userId and optional cohort, each at most 128 characters.'), { status: 400, code: 'INVALID_CONTEXT' });
  }
  const result = { key: flag.key, environment: flag.environment, version: flag.version, value: flag.defaultValue, reason: 'disabled' };
  if (!flag.enabled) return result;
  if (flag.targets.length && !flag.targets.includes(context.cohort)) return { ...result, reason: 'not_targeted' };
  if (bucket([tenant, flag.environment, flag.key, context.userId, 'rollout']) >= flag.rollout) return { ...result, reason: 'outside_rollout' };
  if (flag.type === 'boolean') return { ...result, value: flag.value, reason: 'matched' };
  const assignment = bucket([tenant, flag.environment, flag.key, context.userId, 'variant']);
  let cumulative = 0;
  for (const variant of flag.variants) {
    cumulative += variant.weight;
    if (assignment < cumulative) return { ...result, value: variant.value, reason: 'matched' };
  }
  return { ...result, reason: 'invalid_configuration' };
}
