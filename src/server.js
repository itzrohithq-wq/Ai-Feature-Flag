import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { RuntimeStore } from './runtime-store.js';
import { resourceKinds } from './runtime-schema.js';
import { providersFromEnvironment } from './providers.js';
import { generate, runBenchmark } from './playground.js';
import { Operations } from './operations.js';
import { experimentAnalysis, sampleSize } from './analysis.js';
import {Access} from './access.js';
import {NotificationDelivery} from './notifications.js';
import { builtInTools } from './tool-execution.js';
import { once } from 'node:events';
import { ReleaseWorkflows } from './release-workflows.js';
import { Scim } from './scim.js';
import { ScimGroups } from './scim-groups.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const environments = ['development', 'staging', 'production'];
function error(status, code, message) { return Object.assign(new Error(message), { status, code }); }

export function createApp({ store = new Store(), credentials = [], requireProductionApproval = false, providers = {}, vaultKey = process.env.RUNTIME_VAULT_KEY, sso, toolHandlers = builtInTools, workerMode = 'exclusive' } = {}) {
  const runtime = new RuntimeStore(store);
  runtime.requireProductionApproval=requireProductionApproval;
  const operations = new Operations(runtime,{vaultKey,providers,toolHandlers});
  const access=new Access(operations,{sso});
  const scim=new Scim(access),groups=new ScimGroups(scim);
  const delivery=new NotificationDelivery(operations);
  const workflows=new ReleaseWorkflows(operations);
  const server = createServer(async (req, res) => {
    const traceId = randomUUID();
    const send = (status, body, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers }); res.end(JSON.stringify(body)); };
    try {
      const url = new URL(req.url, 'http://localhost');
      if(req.method==='GET'&&url.pathname==='/auth/sso'){const flow=await access.beginSso();res.writeHead(302,{Location:flow.url,'Cache-Control':'no-store','Set-Cookie':`studio_sso=${flow.state}; HttpOnly; SameSite=Lax; Path=/auth; Max-Age=300${sso.redirectUri.startsWith('https:')?'; Secure':''}`});return res.end();}
      if(req.method==='GET'&&url.pathname==='/auth/callback'){const cookie=(req.headers.cookie??'').split(';').map(v=>v.trim()).find(v=>v.startsWith('studio_sso='))?.slice(11);if(!sso)throw error(409,'SSO_NOT_CONFIGURED','SSO is not configured.');const callback=new URL(req.url,new URL(sso.redirectUri).origin);const exchange=await access.finishSso(callback,cookie);res.writeHead(302,{Location:`/operations#exchange=${exchange}`,'Cache-Control':'no-store','Referrer-Policy':'no-referrer','Set-Cookie':'studio_sso=; HttpOnly; SameSite=Lax; Path=/auth; Max-Age=0'});return res.end();}
      if (req.method === 'GET' && url.pathname === '/health') return send(200, { status: 'ok' });
      const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/agents': ['agents.html','text/html'], '/agents.js':['agents.js','text/javascript'], '/manrope.woff2':['manrope.woff2','font/woff2'] };
      assets['/operations']=['operations.html','text/html'];assets['/operations.js']=['operations.js','text/javascript'];assets['/operations-ui.js']=['operations-ui.js','text/javascript'];assets['/enterprise-ui.js']=['enterprise-ui.js','text/javascript'];
      assets['/welcome']=['welcome.html','text/html'];assets['/welcome.css']=['welcome.css','text/css'];assets['/welcome.js']=['welcome.js','text/javascript'];
      assets['/pogonia-regular.otf']=['pogonia-regular.otf','font/otf'];assets['/pogonia-semibold.otf']=['pogonia-semibold.otf','font/otf'];
      assets['/tour.webm']=['tour.webm','video/webm'];assets['/tour-poster.png']=['tour-poster.png','image/png'];assets['/studio-preview.png']=['studio-preview.png','image/png'];assets['/tour.vtt']=['tour.vtt','text/vtt'];
      if (req.method === 'GET' && assets[url.pathname]) {
        const [file, type] = assets[url.pathname];
        const content = await readFile(resolve(root, 'public', file));
        const headers = { 'Content-Type': type + (type.startsWith('text/') ? '; charset=utf-8' : ''), 'Content-Length': content.length, 'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'", 'X-Content-Type-Options': 'nosniff' };
        if (type === 'video/webm') {
          headers['Accept-Ranges'] = 'bytes';
          if (req.headers.range !== undefined) {
            const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
            const first = match?.[1] ? Number(match[1]) : null;
            const last = match?.[2] ? Number(match[2]) : null;
            const start = first ?? Math.max(0, content.length - (last ?? 0));
            const end = first === null ? content.length - 1 : Math.min(last ?? content.length - 1, content.length - 1);
            if (!match || (first === null && (last === null || last === 0)) || (first !== null && !Number.isSafeInteger(first)) || (last !== null && !Number.isSafeInteger(last)) || start >= content.length || end < start) {
              res.writeHead(416, { ...headers, 'Content-Length': 0, 'Content-Range': `bytes */${content.length}` });
              return res.end();
            }
            res.writeHead(206, { ...headers, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${content.length}` });
            return res.end(content.subarray(start, end + 1));
          }
        }
        res.writeHead(200, headers);
        return res.end(content);
      }
      const cookieToken=(req.headers.cookie??'').split(';').map(v=>v.trim()).find(v=>v.startsWith('studio_session='))?.slice(15)??'';
      const cookieAuth=!req.headers.authorization&&Boolean(cookieToken);
      const token=req.headers.authorization?req.headers.authorization.replace(/^Bearer /,''):cookieToken;
      const origin=process.env.PUBLIC_ORIGIN??`http://${req.headers.host}`;
      const sessionCookie=value=>`studio_session=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${value?3600:0}${origin.startsWith('https:')?'; Secure':''}`;
      if(cookieAuth&&!['GET','HEAD'].includes(req.method)&&req.headers.origin!==origin)throw error(403,'CSRF_FORBIDDEN','Same-origin browser request required.');
      if(['/auth/login','/auth/exchange'].includes(url.pathname)&&req.headers.origin&&req.headers.origin!==origin)throw error(403,'CSRF_FORBIDDEN','Same-origin browser request required.');
      const identity = credentials.find(c => { const a = Buffer.from(c.token); const b = Buffer.from(token); return a.length === b.length && timingSafeEqual(a, b); }) ?? operations.authenticate(token);
      if(!identity&&!['/auth/login','/auth/exchange'].includes(url.pathname))throw error(401,'UNAUTHORIZED','A valid workspace API token is required.');
      const environment = url.searchParams.get('environment') ?? 'development';
      if (!environments.includes(environment)) throw error(400, 'INVALID_ENVIRONMENT', 'Unknown environment.');
      let body = {};
      if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
        const contentType=(req.headers['content-type']??'').split(';')[0].trim().toLowerCase();
        if (contentType!=='application/json' && !(url.pathname.startsWith('/scim/v2/')&&contentType==='application/scim+json')) throw error(415, 'JSON_REQUIRED', 'Send application/json or, for SCIM, application/scim+json.');
        const chunks = []; let size = 0;
        const limit = (['/api/runtime/benchmarks','/api/runtime/traces','/api/runtime/otlp','/api/runtime/playground','/api/runtime/playground/stream'].includes(url.pathname)||url.pathname.startsWith('/api/runtime/datasets/')) ? 4194304 : 65536;
        for await (const chunk of req) { size += chunk.length; if (size > limit) throw error(413, 'BODY_TOO_LARGE', `Request exceeds ${limit / 1024} KB.`); chunks.push(chunk); }
        try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { throw error(400, 'INVALID_JSON', 'Malformed JSON.'); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw error(400, 'INVALID_JSON', 'Request must be an object.');
      }
      if(req.method==='POST'&&url.pathname==='/auth/login'){const session=await access.login(body,req.socket.remoteAddress);const {token:secret,...metadata}=session;return send(200,metadata,{'Set-Cookie':sessionCookie(secret)});}
      if(req.method==='POST'&&url.pathname==='/auth/exchange'){const session=access.exchange(body.code);const {token:secret,...metadata}=session;return send(200,metadata,{'Set-Cookie':sessionCookie(secret)});}
      if (!identity) throw error(401, 'UNAUTHORIZED', 'A valid workspace API token is required.');
      if(req.method==='POST'&&url.pathname==='/auth/logout'){if(identity.credentialId)operations.revoke(identity,identity.credentialId);return send(200,{signedOut:true},{'Set-Cookie':sessionCookie('')});}
      const { tenant, actor, role } = identity;
      const parts = url.pathname.split('/').filter(Boolean);
      if(url.pathname.startsWith('/scim/v2/')){
        scim.authorize(identity);
        const reply=(status,document)=>{const headers={'Content-Type':'application/scim+json; charset=utf-8'};if(document?.meta){headers.ETag=document.meta.version;headers.Location=document.meta.location;}if(status===204){res.writeHead(204,{'Cache-Control':'no-store'});return res.end();}return send(status,document,headers);};
        if(['Schemas','ResourceTypes'].includes(parts[2])&&parts.length<=4&&req.method==='GET')return reply(200,scim.discovery(parts[2],parts[3]?decodeURIComponent(parts[3]):undefined));
        if(parts.length===3&&parts[2]==='ServiceProviderConfig'&&req.method==='GET')return reply(200,{schemas:['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],patch:{supported:true},bulk:{supported:false,maxOperations:0,maxPayloadSize:0},filter:{supported:true,maxResults:200},changePassword:{supported:false},sort:{supported:false},etag:{supported:true},authenticationSchemes:[{type:'oauthbearertoken',name:'Workspace bearer token',description:'Full-workspace administrator bearer credentials',primary:true}]});
        if(!['Users','Groups'].includes(parts[2])||parts.length>4)throw error(404,'NOT_FOUND','This SCIM profile supports Users only.');
        const id=parts[3],resource=parts[2]==='Groups'?groups:scim;
        if(req.method==='GET')return reply(200,id?resource.get(identity,id):resource.list(identity,url.searchParams));
        if(req.method==='POST'&&!id)return reply(201,await resource.create(identity,body));
        if(id&&['PUT','PATCH'].includes(req.method))return reply(200,resource.mutate(identity,id,body,{patch:req.method==='PATCH',ifMatch:req.headers['if-match']}));
        if(id&&req.method==='DELETE'){resource.remove(identity,id,req.headers['if-match']);return reply(204);}
        throw error(405,'METHOD_NOT_ALLOWED','Unsupported SCIM method.');
      }
      if(identity.policy&&url.pathname!=='/api/session'){
        if(!identity.policy.environments.includes(environment))throw error(403,'SCOPE_FORBIDDEN','Credential is not permitted in this environment.');
        if(!identity.policy.resources.includes('*')){let resource=parts[1]==='runtime'&&resourceKinds.includes(parts[2])&&parts[3]?`${parts[2]}/${parts[3]}`:null;if(parts[1]==='runtime'&&['traces','otlp'].includes(parts[2]))resource='telemetry';if(url.pathname==='/api/runtime/outcomes'){const execution=runtime.execution(tenant,environment,body.traceId);resource=`configs/${execution.key}`;}if(!resource||!identity.policy.resources.includes(resource))throw error(403,'SCOPE_FORBIDDEN','Credential is not permitted for this resource or workspace operation.');}
      }
      const key = parts[2];
      if (parts[0] === 'api' && parts[1] === 'runtime') {
        const kind=parts[2],resourceKey=parts[3],operation=parts[4];
        const canEdit=['owner','admin','operator'].includes(role)&&!(environment==='production'&&role==='operator');
        const administrator=['owner','admin'].includes(role);
        const currentProviders=operations.providerSet(tenant);
        if(kind==='enterprise-policy'){if(!administrator)throw error(403,'FORBIDDEN','Administrator role required.');if(req.method==='GET')return send(200,runtime.policies.get(tenant,environment));if(req.method==='PUT')return send(200,runtime.policies.save(identity,environment,body));}
        if(kind==='release-plans'){if(req.method==='GET')return send(200,workflows.plans(tenant,environment));if(!administrator)throw error(403,'FORBIDDEN','Administrator role required.');if(req.method==='POST'&&parts.length===3)return send(201,workflows.create(identity,environment,body));if(req.method==='POST'&&operation==='advance')return send(200,workflows.advance(identity,environment,resourceKey));if(req.method==='POST'&&operation==='cancel')return send(200,workflows.cancel(identity,environment,resourceKey));}
        if(kind==='calibrations'){if(req.method==='GET')return send(200,workflows.calibrations(tenant,environment));if(req.method==='POST'){if(!canEdit)throw error(403,'FORBIDDEN','Editor role required.');return send(201,await workflows.calibrate(identity,environment,body));}}
        if(kind==='metric-import'&&req.method==='POST'){if(!canEdit)throw error(403,'FORBIDDEN','Editor role required.');return send(200,workflows.importMetrics(identity,environment,body));}
        if(kind==='playground'&&resourceKey==='stream'&&req.method==='POST'){
          if(!canEdit)throw error(403,'FORBIDDEN','Your role cannot run provider-backed evaluations here.');
          if(body.allowProviderCalls!==true)throw error(400,'PROVIDER_CALLS_NOT_AUTHORIZED','Explicitly authorize provider calls.');
          const controller=new AbortController();res.on('close',()=>controller.abort());
          const event=async value=>{if(controller.signal.aborted)throw new Error('Browser disconnected.');if(!res.headersSent)res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Accel-Buffering':'no'});if(!res.write(`data: ${JSON.stringify(value)}\n\n`))await once(res,'drain',{signal:controller.signal});};
          const result=runtime.savePlayground(tenant,environment,await generate(runtime,currentProviders,tenant,environment,body,{onEvent:event,signal:controller.signal,toolHandlers}));await event({type:'completed',result});return res.end();
        }
        if(kind==='retention'&&req.method==='POST'){if(!administrator)throw error(403,'FORBIDDEN','Administrator role required.');return send(200,operations.retention(identity,environment,body));}
        if(kind==='channels'){if(!administrator)throw error(403,'FORBIDDEN','Administrator role required.');if(req.method==='GET'&&parts.length===3)return send(200,{channels:delivery.channels(tenant,environment),deliveries:delivery.deliveries(tenant,environment)});if(req.method==='POST'&&parts.length===3)return send(201,delivery.add(identity,environment,body));if(req.method==='POST'&&operation==='remove')return send(200,delivery.remove(identity,environment,resourceKey));}
        if(kind==='accounts'){if(!administrator)throw error(403,'FORBIDDEN','Administrator role required.');if(req.method==='GET'&&parts.length===3)return send(200,access.users(tenant));if(req.method==='POST'&&parts.length===3)return send(201,await access.create(identity,body));if(req.method==='POST'&&operation==='disable')return send(200,access.disable(identity,resourceKey));if(req.method==='POST'&&operation==='role')return send(200,access.changeRole(identity,resourceKey,body));if(req.method==='POST'&&operation==='link-sso')return send(200,access.linkSso(identity,resourceKey,body.subject));}
        if(kind==='mfa'&&req.method==='POST'){if(resourceKey==='enroll')return send(200,await access.enroll(identity,body));if(resourceKey==='confirm')return send(200,access.confirm(identity,body.code));}
        if(kind==='password'&&req.method==='POST')return send(200,await access.changePassword(identity,body));
        if(kind==='credentials') {
          if(!administrator)throw error(403,'FORBIDDEN','Administrator role required.');
          if(req.method==='GET'&&parts.length===3)return send(200,operations.tokens(tenant));
          if(req.method==='POST'&&parts.length===3)return send(201,operations.issue(identity,body));
          if(req.method==='POST'&&operation==='revoke')return send(200,operations.revoke(identity,resourceKey));
        }
        if(kind==='secrets') {
          if(!administrator)throw error(403,'FORBIDDEN','Administrator role required.');
          if(req.method==='PUT'&&parts.length===4)return send(200,operations.putSecret(identity,resourceKey,body.value));
          if(req.method==='POST'&&operation==='remove')return send(200,operations.removeSecret(identity,resourceKey));
        }
        if(kind==='jobs') {
          if(req.method==='GET')return send(200,resourceKey?operations.job(tenant,environment,resourceKey):operations.jobs(tenant,environment));
          if(!canEdit)throw error(403,'FORBIDDEN','Your role cannot manage evaluation jobs here.');
          if(req.method==='POST'&&parts.length===3)return send(202,operations.enqueue(identity,environment,body));
          if(req.method==='POST'&&['cancel','resume'].includes(operation))return send(200,operations.jobAction(identity,environment,resourceKey,operation));
        }
        if(kind==='traces'&&parts.length===3){if(req.method==='GET')return send(200,operations.traces(tenant,environment));if(req.method==='POST')return send(200,operations.ingest(tenant,environment,body));}
        if(kind==='otlp'&&parts.length===3&&req.method==='POST'){operations.ingest(tenant,environment,body);return send(200,{});}
        if(kind==='notifications'){if(req.method==='GET'&&parts.length===3)return send(200,operations.notifications(tenant,environment));if(req.method==='POST'&&operation==='read')return send(200,operations.acknowledge(tenant,environment,resourceKey));}
        if(kind==='schedules'&&parts.length===3){if(req.method==='GET')return send(200,operations.schedules(tenant,environment));if(req.method==='POST'){if(!canEdit)throw error(403,'FORBIDDEN','Cannot schedule changes.');return send(202,operations.schedule(identity,environment,body));}}
        if(kind==='schedules'&&req.method==='POST'&&operation==='review'){if(!['owner','admin','reviewer'].includes(role))throw error(403,'FORBIDDEN','Reviewer role required.');return send(200,operations.reviewSchedule(identity,environment,resourceKey,body.decision));}
        if(kind==='schedules'&&req.method==='POST'&&operation==='cancel'){if(!canEdit)throw error(403,'FORBIDDEN','Cannot cancel this schedule.');return send(200,operations.cancelSchedule(identity,environment,resourceKey));}
        if(kind==='analysis'&&req.method==='POST')return send(200,sampleSize(body));
        if(kind==='export'&&req.method==='GET')return send(200,{insights:runtime.insights(tenant,environment),traces:operations.traces(tenant,environment),audit:store.audit(tenant)});
        if(kind==='configs'&&operation==='analysis'&&req.method==='GET') {const config=runtime.get(tenant,environment,'configs',resourceKey);const records=runtime.outcomes(tenant,environment,resourceKey,config.version);const exposures=runtime.db.prepare('SELECT id,variation,config FROM runtime_executions WHERE tenant=? AND environment=? AND key=? AND version=?').all(tenant,environment,resourceKey,config.version).map(r=>({...r,subject:JSON.parse(r.config).subject,reason:JSON.parse(r.config).reason}));return send(200,experimentAnalysis(config,records,exposures));}
        if(req.method==='GET' && kind==='overview' && parts.length===3) return send(200,runtime.overview(tenant,environment));
        if(req.method==='GET' && kind==='insights' && parts.length===3) return send(200,runtime.insights(tenant,environment,{from:url.searchParams.get('from'),to:url.searchParams.get('to'),key:url.searchParams.get('key')}));
        if(req.method==='GET' && kind==='snapshot' && parts.length===3) return send(200,runtime.snapshot(tenant,environment));
        if(req.method==='GET' && kind==='providers' && parts.length===3) return send(200,['openai','anthropic','gemini','bedrock','custom'].map(name=>({name,configured:Boolean(currentProviders[name])})));
        if(req.method==='GET' && kind==='playground' && parts.length===3) return send(200,runtime.playgroundHistory(tenant,environment));
        if(req.method==='POST' && ((kind==='playground' && parts.length===3)||(kind==='benchmarks' && resourceKey==='run' && parts.length===4))) {
          if(!['owner','admin','operator'].includes(role))throw error(403,'FORBIDDEN','Your role cannot run provider-backed evaluations.');
          if(body.allowProviderCalls!==true)throw error(400,'PROVIDER_CALLS_NOT_AUTHORIZED','Explicitly authorize provider calls for this run.');
          if(kind==='playground')return send(200,runtime.savePlayground(tenant,environment,await generate(runtime,currentProviders,tenant,environment,body,{toolHandlers})));
          return send(200,await runBenchmark(runtime,currentProviders,tenant,environment,body));
        }
        if(req.method==='GET' && kind==='approvals' && parts.length===3) return send(200,runtime.approvals(tenant,environment));
        if(req.method==='POST' && kind==='approvals' && resourceKey && parts.length===4) {
          if(!['owner','admin','reviewer'].includes(role))throw error(403,'FORBIDDEN','Your role cannot review changes.');
          return send(200,runtime.review(tenant,environment,actor,resourceKey,body.decision));
        }
        if(req.method==='POST' && kind==='outcomes' && parts.length===3) return send(200,runtime.outcome(tenant,environment,body));
        if(req.method==='POST' && kind==='benchmarks' && parts.length===3) {
          if(!['owner','admin','operator'].includes(role)) throw error(403,'FORBIDDEN','Your role cannot submit benchmark results.');
          return send(200,runtime.benchmark(tenant,environment,body));
        }
        if(resourceKinds.includes(kind)) {
          if(req.method==='GET' && parts.length===3) return send(200,runtime.list(tenant,environment,kind));
          if(req.method==='GET' && resourceKey && parts.length===4) return send(200,runtime.get(tenant,environment,kind,resourceKey));
          if(req.method==='GET'&&kind==='configs'&&resourceKey&&operation==='watch'&&parts.length===5){let version=-1;runtime.get(tenant,environment,kind,resourceKey);res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});const update=()=>{try{if(identity.credentialId&&!operations.authenticate(token)){res.end();return;}const document=runtime.get(tenant,environment,kind,resourceKey);if(document.version!==version){version=document.version;res.write(`event: configuration\ndata: ${JSON.stringify(document)}\n\n`);}}catch{res.end();}};update();const timer=setInterval(update,500);timer.unref();req.on('close',()=>clearInterval(timer));return;}
          if(req.method==='GET' && resourceKey && operation==='history' && parts.length===5) return send(200,runtime.history(tenant,environment,kind,resourceKey));
          if(req.method==='GET' && kind==='configs' && resourceKey && operation==='metrics' && parts.length===5) return send(200,runtime.metrics(tenant,environment,resourceKey));
          if(req.method==='GET' && kind==='graphs' && resourceKey && operation==='metrics' && parts.length===5) return send(200,runtime.graphMetrics(tenant,environment,resourceKey));
          if(req.method==='POST' && resourceKey && operation==='resolve' && parts.length===5) {
            if(kind==='configs') return send(200,runtime.resolve(tenant,environment,resourceKey,body));
            if(kind==='graphs') return send(200,runtime.transaction(()=>runtime.graph(tenant,environment,resourceKey,body)));
          }
          if(req.method==='POST' && kind==='configs' && resourceKey && operation==='retry' && parts.length===5) return send(200,runtime.transaction(()=>runtime.retry(tenant,environment,resourceKey,body)));
          if(req.method==='POST' && kind==='graphs' && resourceKey && operation==='visit' && parts.length===5) return send(200,runtime.visit(tenant,environment,resourceKey,body));
          if((req.method==='PUT' && parts.length===4) || (req.method==='POST' && parts.length===5 && ['restore','stop','preview'].includes(operation))) {
            if(!['owner','admin','operator'].includes(role) || (environment==='production' && role==='operator')) throw error(403,'FORBIDDEN','Your role cannot edit runtime resources in this environment.');
            if(operation==='restore') {
              if(environment==='production' && requireProductionApproval) {
                const original=runtime.get(tenant,environment,kind,resourceKey,body.version);
                if(kind==='configs') {delete original.guard;delete original.trigger;delete original.progressive;delete original.experiment;}
                return send(202,runtime.requestApproval(tenant,environment,actor,kind,original,body.expectedVersion));
              }
              return send(200,runtime.restore(tenant,environment,actor,kind,resourceKey,body));
            }
            if(operation==='preview' && kind==='configs') return send(200,runtime.resolve(tenant,environment,resourceKey,body,{override:body.variation}));
            if(operation==='stop' && kind==='configs') {
              const current=runtime.get(tenant,environment,kind,resourceKey);current.enabled=false;
              return send(200,runtime.save(tenant,environment,actor,kind,current,body.expectedVersion,'runtime_stop'));
            }
            if(req.method==='PUT') {
              if(environment==='production' && requireProductionApproval) return send(202,runtime.requestApproval(tenant,environment,actor,kind,{...body,key:resourceKey},body.expectedVersion));
              return send(200,runtime.save(tenant,environment,actor,kind,{...body,key:resourceKey},body.expectedVersion));
            }
          }
        }
        throw error(404,'NOT_FOUND','Runtime route not found.');
      }
      if (req.method === 'GET' && url.pathname === '/api/session') return send(200, { tenant, actor, role });
      if (req.method === 'GET' && url.pathname === '/api/flags') return send(200, store.list(tenant, environment));
      if (req.method === 'GET' && url.pathname === '/api/audit') return send(200, identity.policy?store.audit(tenant).filter(r=>identity.policy.environments.includes(r.environment)):store.audit(tenant));
      if (req.method === 'GET' && url.pathname === '/api/stats') return send(200, store.stats(tenant, environment));
      if (parts[0] === 'api' && parts[1] === 'flags' && key) {
        if (req.method === 'GET' && parts.length === 3) return send(200, store.get(tenant, environment, key));
        if (req.method === 'GET' && parts[3] === 'history') return send(200, store.history(tenant, environment, key));
        if (req.method === 'POST' && parts[3] === 'evaluate') return send(200, store.decide(tenant, environment, key, body));
        if (['PUT', 'POST'].includes(req.method)) {
          if (!['owner', 'admin', 'operator'].includes(role) || (environment === 'production' && role === 'operator')) throw error(403, 'FORBIDDEN', 'Your role cannot edit flags in this environment.');
          if (req.method === 'PUT' && parts.length === 3) return send(200, store.save(tenant, actor, { ...body, key, environment }, body.expectedVersion));
          if (req.method === 'POST' && parts[3] === 'kill') {
            const flag = store.get(tenant, environment, key);
            return send(200, store.save(tenant, actor, { ...flag, enabled: false }, body.expectedVersion, 'kill'));
          }
        }
      }
      throw error(404, 'NOT_FOUND', 'Route not found.');
    } catch (err) { if(req.url?.split('?')[0].startsWith('/scim/v2/')&&!res.headersSent)return send(err.status??500,{schemas:['urn:ietf:params:scim:api:messages:2.0:Error'],status:String(err.status??500),detail:err.status?err.message:'Unexpected server error.',...(err.scimType?{scimType:err.scimType}:{})},{'Content-Type':'application/scim+json; charset=utf-8'});const body={error:{code:err.code??'INTERNAL_ERROR',message:err.status?err.message:'Unexpected server error.',traceId}};if(res.headersSent){if(!res.destroyed)res.end(`data: ${JSON.stringify({type:'error',...body})}\n\n`);}else send(err.status??500,body); }
  });
  let standby;
  const acquire=()=>{try{operations.start();clearInterval(standby);}catch(error){if(workerMode!=='auto'||!error.message.startsWith('Another worker'))throw error;}};
  if(workerMode!=='disabled'){acquire();if(!operations.timer){standby=setInterval(acquire,2000);standby.unref();}}
  const deliveryTimer=setInterval(()=>{if(operations.timer&&!operations.closed)delivery.tick().catch(()=>{});},2000);deliveryTimer.unref();server.on('close',()=>{clearInterval(standby);clearInterval(deliveryTimer);operations.close();});server.operations=operations;server.access=access;return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try{process.loadEnvFile(resolve(root,'.env'));}catch(error){if(error.code!=='ENOENT')throw error;}
  const token = process.env.FLAG_ADMIN_TOKEN || randomBytes(32).toString('hex');
  const credentials = process.env.FLAG_CREDENTIALS_JSON ? JSON.parse(process.env.FLAG_CREDENTIALS_JSON) : [{ token, tenant: 'local-workspace', actor: 'local-owner', role: 'owner' }];
  const store = new Store(process.env.FLAG_DB_PATH || resolve(root, 'data', 'flags.sqlite'));
  let vaultKey=process.env.RUNTIME_VAULT_KEY;
  if(!vaultKey){const path=resolve(root,'data','vault.key');await mkdir(dirname(path),{recursive:true});try{vaultKey=(await readFile(path,'utf8')).trim();}catch(err){if(err.code!=='ENOENT')throw err;vaultKey=randomBytes(32).toString('hex');await writeFile(path,vaultKey,{mode:0o600,flag:'wx'});}}
  const sso=process.env.OIDC_ISSUER?{issuer:process.env.OIDC_ISSUER,clientId:process.env.OIDC_CLIENT_ID,clientSecret:process.env.OIDC_CLIENT_SECRET,redirectUri:process.env.OIDC_REDIRECT_URI}:undefined;
  const app = createApp({ store, credentials, vaultKey, sso, workerMode:process.env.WORKER_MODE??'exclusive', requireProductionApproval: process.env.REQUIRE_PRODUCTION_APPROVAL === 'true', providers:providersFromEnvironment() });
  const port = Number(process.env.PORT || 4315);
  app.listen(port, process.env.BIND_HOST || '127.0.0.1', () => console.log(`Dashboard: http://127.0.0.1:${port}\nLocal owner token: ${token}\nToken changes each restart unless FLAG_ADMIN_TOKEN is configured.`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => app.close(() => { store.close(); process.exit(0); }));
  process.on('message',message=>{if(message?.command==='shutdown')app.close(()=>{store.close();process.exit(0);});});
}



