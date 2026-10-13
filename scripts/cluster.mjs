import cluster from 'node:cluster';
import {randomBytes} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {availableParallelism} from 'node:os';
import {fileURLToPath} from 'node:url';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
if(cluster.isPrimary){
  try{process.loadEnvFile(resolve(root,'.env'));}catch(e){if(e.code!=='ENOENT')throw e;}
  const workers=Number(process.env.API_WORKERS??Math.min(4,availableParallelism()));
  if(!Number.isInteger(workers)||workers<2||workers>8)throw new Error('API_WORKERS must be 2–8.');
  mkdirSync(resolve(root,'data'),{recursive:true});
  if(!process.env.RUNTIME_VAULT_KEY){const path=resolve(root,'data/vault.key');try{process.env.RUNTIME_VAULT_KEY=readFileSync(path,'utf8').trim();}catch(e){if(e.code!=='ENOENT')throw e;process.env.RUNTIME_VAULT_KEY=randomBytes(32).toString('hex');writeFileSync(path,process.env.RUNTIME_VAULT_KEY,{flag:'wx',mode:0o600});}}
  process.env.FLAG_ADMIN_TOKEN??=randomBytes(32).toString('hex');
  process.env.WORKER_MODE='auto';
  // Bootstrap migrations serially before workers share the local WAL database.
  const {Store}=await import('../src/store.js'),{createApp}=await import('../src/server.js');
  const store=new Store(process.env.FLAG_DB_PATH??resolve(root,'data/flags.sqlite'));const app=createApp({store,vaultKey:process.env.RUNTIME_VAULT_KEY,workerMode:'disabled'});app.operations.close();store.close();
  cluster.setupPrimary({exec:resolve(root,'src/server.js')});
  for(let i=0;i<workers;i++)cluster.fork();
  let stopping=false;cluster.on('exit',()=>{if(!stopping)cluster.fork();});
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{stopping=true;for(const worker of Object.values(cluster.workers))worker?.process.kill(signal);});
  process.on('message',message=>{if(message?.command==='shutdown'){stopping=true;for(const worker of Object.values(cluster.workers))worker?.send({command:'shutdown'});cluster.disconnect(()=>process.exit(0));}});
  console.log(`Control studio: ${workers} API workers, elected background worker, shared local WAL database.`);
}
