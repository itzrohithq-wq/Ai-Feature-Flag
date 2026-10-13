import { timingSafeEqual } from 'node:crypto';
import { createHostedApp } from '../src/hosted-app.js';
import { hostedWork } from '../src/hosted-worker.js';
import { waitUntil } from '@vercel/functions';
import { Receiver } from '@upstash/qstash';
import { Readable } from 'node:stream';

let app;
let nextWake = 0;
const equal = (a, b) => Boolean(a && b && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b)));
export default async function handler(req, res) {
  try {
    app ??= createHostedApp();
    if (req.url.split('?')[0] === '/api/worker') {
      let authorized = Boolean(process.env.CRON_SECRET && equal(req.headers.authorization, `Bearer ${process.env.CRON_SECRET}`));
      if (!authorized && req.method==='POST' && req.headers['upstash-signature'] && process.env.QSTASH_CURRENT_SIGNING_KEY && process.env.QSTASH_NEXT_SIGNING_KEY) {
        const chunks=[];let size=0;
        if(req.body===undefined)for await(const chunk of req){size+=chunk.length;if(size>16384)throw new Error('Worker payload too large');chunks.push(chunk);}
        const body=req.body===undefined?Buffer.concat(chunks).toString():typeof req.body==='string'?req.body:JSON.stringify(req.body);
        try { authorized=await new Receiver({currentSigningKey:process.env.QSTASH_CURRENT_SIGNING_KEY,nextSigningKey:process.env.QSTASH_NEXT_SIGNING_KEY}).verify({signature:req.headers['upstash-signature'],body,url:(process.env.PUBLIC_ORIGIN??`https://${req.headers.host}`)+'/api/worker'}); } catch { authorized=false; }
      }
      if (!authorized) {
        res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end('{"error":"Unauthorized"}');
      }
      const result = await hostedWork(app);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(result));
    }
    // API writes and polling also wake durable work. The external scheduler is
    // responsible for deadlines and jobs while no browser is open.
    if (Date.now()>=nextWake && req.url.startsWith('/api/') && (req.headers.authorization || req.headers.cookie?.includes('studio_session='))) {
      const auth = req.headers.authorization?.replace(/^Bearer /, '');
      if (equal(auth, process.env.FLAG_ADMIN_TOKEN) || app.operations.authenticate(auth ?? req.headers.cookie?.split('studio_session=')[1]?.split(';')[0] ?? '')) {
        nextWake=Date.now()+5000;
        waitUntil(hostedWork(app).catch(() => {}));
      }
    }
    let incoming=req;
    if(req.body!==undefined && ['POST','PUT','PATCH'].includes(req.method)){
      const raw=typeof req.body==='string'?req.body:JSON.stringify(req.body);
      incoming=Readable.from([Buffer.from(raw)]);
      Object.assign(incoming,{url:req.url,method:req.method,headers:req.headers,socket:req.socket});
    }
    app.emit('request', incoming, res);
  } catch {
    res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end('{"error":"Hosted service unavailable. Check server configuration."}');
  }
}
