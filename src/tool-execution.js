import { fail } from './runtime-schema.js';

// Only explicitly registered application functions execute; schemas are not code.
export function validateToolSchema(schema,depth=0){
  if(depth>12||!schema||typeof schema!=='object'||Array.isArray(schema)||JSON.stringify(schema).length>60000)fail('Tool schema must be a bounded object up to 12 levels deep.');
  const supported=['type','properties','required','additionalProperties','items','enum','minimum','maximum','minLength','maxLength','minItems','maxItems','description','title','$schema'];
  if(Object.keys(schema).some(key=>!supported.includes(key)))fail('Tool schema uses an unsupported constraint. Supported constraints include typed properties, required, enum, numeric bounds and string/array lengths.');
  if(schema.type!==undefined&&!['object','array','string','number','integer','boolean','null'].includes(schema.type))fail('Unsupported tool schema type.');
  if(schema.required!==undefined&&(!Array.isArray(schema.required)||schema.required.length>100||schema.required.some(key=>typeof key!=='string'||key.length>128)))fail('Required arguments must be bounded property names.');
  if(schema.additionalProperties!==undefined&&typeof schema.additionalProperties!=='boolean')fail('additionalProperties must be Boolean.');
  if(schema.enum!==undefined&&(!Array.isArray(schema.enum)||!schema.enum.length||schema.enum.length>100))fail('Tool enum must contain 1–100 allowed values.');
  for(const key of ['minimum','maximum'])if(schema[key]!==undefined&&!Number.isFinite(schema[key]))fail('Tool numeric bounds must be finite.');
  for(const key of ['minLength','maxLength','minItems','maxItems'])if(schema[key]!==undefined&&(!Number.isInteger(schema[key])||schema[key]<0||schema[key]>10000))fail('Tool size bounds must be integers from 0 to 10000.');
  for(const [min,max]of [['minimum','maximum'],['minLength','maxLength'],['minItems','maxItems']])if(schema[min]!==undefined&&schema[max]!==undefined&&schema[min]>schema[max])fail('Tool minimum cannot exceed its maximum.');
  if(schema.properties!==undefined){if(!schema.properties||typeof schema.properties!=='object'||Array.isArray(schema.properties)||Object.keys(schema.properties).length>100)fail('Tool properties must be a bounded object.');for(const value of Object.values(schema.properties))validateToolSchema(value,depth+1);}
  if(schema.items!==undefined)validateToolSchema(schema.items,depth+1);
  return schema;
}
export function validateToolInput(schema, value, depth = 0) {
  if (depth > 12 || !schema || typeof schema !== 'object') fail('Tool input schema is too deeply nested.');
  if (schema.enum && !schema.enum.some(item => JSON.stringify(item) === JSON.stringify(value))) fail('Tool argument is outside its allowed values.');
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Tool arguments must be an object.');
    for (const key of schema.required ?? []) if (!Object.hasOwn(value,key)) fail(`Required tool argument: ${key}.`);
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties&&Object.hasOwn(schema.properties,key)) validateToolInput(schema.properties[key], item, depth + 1);
      else if (schema.additionalProperties === false) fail(`Unknown tool argument: ${key}.`);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length > (schema.maxItems ?? 100) || value.length < (schema.minItems ?? 0)) fail('Invalid tool argument array.');
    if (schema.items) for (const item of value) validateToolInput(schema.items, item, depth + 1);
  } else if (schema.type === 'string') {
    if (typeof value !== 'string' || value.length > (schema.maxLength ?? 8000) || value.length < (schema.minLength ?? 0)) fail('Invalid tool text argument.');
  } else if (['number', 'integer'].includes(schema.type)) {
    if (!Number.isFinite(value) || schema.type === 'integer' && !Number.isInteger(value) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) fail('Invalid numeric tool argument.');
  } else if (schema.type === 'boolean' && typeof value !== 'boolean') fail('Invalid Boolean tool argument.');
  else if (schema.type && !['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(schema.type)) fail('Unsupported tool schema type.');
  else if (schema.type === 'null' && value !== null) fail('Invalid null tool argument.');
  return value;
}

export const builtInTools = {
  calculator: async ({ operation, values }) => {
    if (!['sum', 'mean', 'min', 'max'].includes(operation) || !Array.isArray(values) || !values.length || values.length > 100 || values.some(v => !Number.isFinite(v))) fail('Calculator needs sum, mean, min or max and 1–100 finite numbers.');
    const sum = values.reduce((a, b) => a + b, 0);
    const value = operation === 'sum' ? sum : operation === 'mean' ? sum / values.length : operation === 'min' ? Math.min(...values) : Math.max(...values);
    if (!Number.isFinite(value)) fail('Calculator result exceeds its numeric range.');
    return { value };
  }
};

export async function invokeTool(definition, args, { handlers, approvedTools = [], signal }) {
  if (!definition || !handlers || !Object.hasOwn(handlers,definition.key) || typeof handlers[definition.key] !== 'function') fail('This tool has no registered server handler.', 'TOOL_NOT_CONFIGURED', 409);
  if (definition.requiresApproval && !approvedTools.includes(definition.key)) fail(`Approve ${definition.key} explicitly before execution.`, 'TOOL_APPROVAL_REQUIRED', 409);
  validateToolSchema(definition.inputSchema);if(JSON.stringify(args??null).length>16000)fail('Tool input exceeds 16 KB.');validateToolInput(definition.inputSchema, args);
  signal?.throwIfAborted();
  const result = await handlers[definition.key](args, { signal, definition });
  signal?.throwIfAborted();
  const output = JSON.stringify(result ?? null);
  if (output.length > 16000) fail('Tool output exceeds 16 KB.');
  return output;
}
