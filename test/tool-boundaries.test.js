import test from 'node:test';
import assert from 'node:assert/strict';
import {invokeTool,validateToolSchema,validateToolInput} from '../src/tool-execution.js';
test('tool execution rejects inherited handlers, inherited required values and unsupported schemas',async()=>{
  const definition={key:'constructor',inputSchema:{type:'object',properties:{value:{type:'string'}},required:['value'],additionalProperties:false}};
  await assert.rejects(invokeTool(definition,{value:'test'},{handlers:{}}),/registered server handler/);
  assert.throws(()=>validateToolInput(definition.inputSchema,Object.create({value:'test'})),/Required tool argument/);
  assert.throws(()=>validateToolSchema({type:'string',pattern:'unsafe-to-ignore'}),/unsupported constraint/);
  let called=false;
  await assert.rejects(invokeTool({...definition,key:'safe',inputSchema:{type:'object',oneOf:[]}},{},{handlers:{safe:()=>{called=true;}}}),/unsupported constraint/);
  assert.equal(called,false);
});
