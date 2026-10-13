import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../src/store.js';
import {createApp} from '../src/server.js';
test('browser sessions persist across pages, enforce origin, and revoke on logout',async()=>{
 const store=new Store(),app=createApp({store,vaultKey:'a'.repeat(64)});
 await new Promise(r=>app.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${app.address().port}`;
 try{
 await app.access.create({tenant:'team',actor:'owner'},{actor:'member',role:'reader',password:'long-fixture-password'});
 const login=await fetch(`${base}/auth/login`,{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify({tenant:'team',actor:'member',password:'long-fixture-password'})});
 assert.equal(login.status,200);assert.equal((await login.json()).token,undefined);
 const setCookie=login.headers.get('set-cookie');assert.match(setCookie,/HttpOnly; SameSite=Strict/);const cookie=setCookie.split(';')[0];
 for(const route of ['/api/session','/api/runtime/overview'])assert.equal((await fetch(base+route,{headers:{Cookie:cookie}})).status,200);
 assert.equal((await fetch(`${base}/api/session`,{headers:{Cookie:cookie,Authorization:'Bearer invalid'}})).status,401);
 for(const origin of [undefined,'https://foreign.example'])assert.equal((await fetch(`${base}/auth/logout`,{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json',...(origin?{Origin:origin}:{})},body:'{}'})).status,403);
 const logout=await fetch(`${base}/auth/logout`,{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json',Origin:base},body:'{}'});assert.equal(logout.status,200);assert.match(logout.headers.get('set-cookie'),/Max-Age=0/);
 assert.equal((await fetch(`${base}/api/session`,{headers:{Cookie:cookie}})).status,401);
 }finally{await new Promise(r=>app.close(r));store.close();}
});
