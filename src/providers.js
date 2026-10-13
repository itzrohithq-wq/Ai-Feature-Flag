import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { executeOpenAI } from './openai-execution.js';
import { executeNative } from './native-execution.js';
import { executeBedrock } from './bedrock-execution.js';

export function openaiAdapter({apiKey,fetchImpl=fetch}) {
  return Object.assign(request=>executeOpenAI({apiKey,fetchImpl,...request}),{capabilities:{streaming:true,images:true,tools:true}});
}
export function anthropicAdapter({apiKey,fetchImpl=fetch}) {
  return Object.assign(request=>executeNative({provider:'anthropic',apiKey,fetchImpl,...request}),{capabilities:{streaming:true,images:true,tools:true}});
}
export function geminiAdapter({apiKey,fetchImpl=fetch}) {
  return Object.assign(request=>executeNative({provider:'gemini',apiKey,fetchImpl,...request}),{capabilities:{streaming:true,images:true,tools:true}});
}
export function bedrockAdapter({region,credentials,client}) {
  if(!/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(region))throw new Error('A valid AWS region is required.');
  const runtime=client ?? new BedrockRuntimeClient({region,...(credentials?{credentials}:{}),maxAttempts:1});
  return Object.assign(request=>executeBedrock(runtime,request),{capabilities:{streaming:true,images:true,tools:true}});
}

export function providersFromEnvironment(env=process.env) {
  const providers={};
  if(env.OPENAI_API_KEY)providers.openai=openaiAdapter({apiKey:env.OPENAI_API_KEY});
  if(env.ANTHROPIC_API_KEY)providers.anthropic=anthropicAdapter({apiKey:env.ANTHROPIC_API_KEY});
  if(env.GEMINI_API_KEY)providers.gemini=geminiAdapter({apiKey:env.GEMINI_API_KEY});
  if(env.AWS_REGION && env.ENABLE_BEDROCK==='true')providers.bedrock=bedrockAdapter({region:env.AWS_REGION});
  return providers;
}
