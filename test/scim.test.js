import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { RuntimeStore } from '../src/runtime-store.js';
import { Operations } from '../src/operations.js';
import { Access } from '../src/access.js';
import { Scim, USER_SCHEMA } from '../src/scim.js';
import { createApp } from '../src/server.js';
const patch=Operations=>({schemas:['urn:ietf:params:scim:api:messages:2.0:PatchOp'],Operations});

test('SCIM Users enforce tenancy, uniqueness, pagination, atomic PATCH and revocation',async()=>{
  const store=new Store(),ops=new Operations(new RuntimeStore(store)),access=new Access(ops),scim=new Scim(access);
  const admin={tenant:'team',actor:'admin',role:'admin'};
  try {
    const user=await scim.create(admin,{schemas:[USER_SCHEMA],userName:'Alice@example.com',externalId:'directory-1',displayName:'Alice'});
    assert.equal(user.userName,'alice@example.com'); assert.equal(user.roles[0].value,'reader');
    assert.equal('password' in user,false);
    await assert.rejects(scim.create(admin,{userName:'ALICE@example.com'}),{status:409,scimType:'uniqueness'});
    await assert.rejects(access.create(admin,{actor:'ALICE@example.com',role:'reader',password:'fixture-long-password'}),{status:409});
    await assert.rejects(scim.create(admin,{userName:'bob',externalId:'directory-1'}),{status:409});
    const bob=await scim.create(admin,{userName:'bob'});
    const concurrent=await Promise.allSettled([scim.create(admin,{userName:'concurrent-user'}),scim.create(admin,{userName:'CONCURRENT-USER'})]);
    assert.equal(concurrent.filter(result=>result.status==='fulfilled').length,1);
    assert.equal(concurrent.find(result=>result.status==='rejected').reason.status,409);
    scim.remove(admin,concurrent.find(result=>result.status==='fulfilled').value.id);
    assert.throws(()=>scim.list(admin,new URLSearchParams('count=1000000')),{status:400});
    assert.equal(scim.list(admin,new URLSearchParams('count=0')).totalResults,2);
    assert.equal(scim.list(admin,new URLSearchParams('count=1&startIndex=2')).Resources.length,1);
    assert.equal(scim.list(admin,new URLSearchParams({filter:'userName eq "ALICE@example.com"'})).Resources[0].id,user.id);
    assert.throws(()=>scim.list(admin,new URLSearchParams({filter:'userName co "alice"'})),{status:400,scimType:'invalidFilter'});
    assert.throws(()=>scim.get({...admin,tenant:'other'},user.id),{status:404});
    assert.throws(()=>scim.get({...admin,role:'reader'},user.id),{status:403});
    const token=ops.issue(admin,{actor:user.userName,role:'reader',days:1});
    assert.throws(()=>scim.mutate(admin,user.id,patch([{op:'replace',path:'active',value:false},{op:'replace',path:'password',value:'bad'}]),{patch:true}),{status:400});
    assert.ok(ops.authenticate(token.token));assert.equal(scim.get(admin,user.id).active,true);
    const disabled=scim.mutate(admin,user.id,patch([{op:'replace',path:'active',value:false}]),{patch:true,ifMatch:user.meta.version});
    assert.equal(disabled.active,false);assert.equal(ops.authenticate(token.token),null);
    assert.throws(()=>scim.mutate(admin,user.id,{userName:'alice@example.com'},{ifMatch:user.meta.version}),{status:412});
    const enabled=scim.mutate(admin,user.id,{userName:'alice@example.com',active:true});
    assert.equal(enabled.active,true);assert.equal(enabled.externalId,undefined);
    const relinkToken=ops.issue(admin,{actor:enabled.userName,role:'reader',days:1});
    assert.equal(access.linkSso(admin,user.id,'directory-subject').linked,true);
    assert.equal(ops.authenticate(relinkToken.token),null);
    assert.throws(()=>access.linkSso({...admin,tenant:'other'},user.id,'other-subject'),{status:404});
    assert.throws(()=>access.linkSso(admin,bob.id,'directory-subject'),{status:409});
    const promoted=access.changeRole(admin,user.id,{role:'admin',expectedRole:'reader'});assert.equal(promoted.role,'admin');
    const elevatedToken=ops.issue(admin,{actor:enabled.userName,role:'admin',days:1});access.changeRole(admin,user.id,{role:'reader',expectedRole:'admin'});assert.equal(ops.authenticate(elevatedToken.token),null);
    assert.throws(()=>access.changeRole(admin,user.id,{role:'operator',expectedRole:'admin'}),{status:409});
    scim.remove(admin,bob.id);assert.throws(()=>scim.get(admin,bob.id),{status:404});
    await assert.rejects(scim.create(admin,{userName:'bob'}),{status:409});
    assert.equal(scim.list(admin,new URLSearchParams()).totalResults,1);
    await assert.rejects(scim.create(admin,{userName:'root',roles:[{value:'admin'}]}),{status:400});
    assert.throws(()=>scim.get({...admin,policy:{resources:['configs/example'],environments:['development']}},user.id),{status:403});
    assert.throws(()=>scim.get({...admin,policy:{resources:['*'],environments:['development','development','development']}},user.id),{status:403});
  } finally {ops.close();store.close();}
});

test('SCIM HTTP protocol uses SCIM content types, ETags, errors and authenticated provisioning',async()=>{
  const store=new Store(),server=createApp({store,credentials:[{token:'test-owner',tenant:'team',actor:'owner',role:'owner'},{token:'test-reader',tenant:'team',actor:'reader',role:'reader'}],workerMode:'disabled'});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}/scim/v2`;
  const request=(path,method='GET',body,token='test-owner',headers={})=>fetch(base+path,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/scim+json',...headers},...(body?{body:JSON.stringify(body)}:{})});
  try {
    const config=await request('/ServiceProviderConfig');assert.equal(config.status,200);assert.equal((await config.json()).bulk.supported,false);
    assert.equal((await (await request('/ResourceTypes')).json()).Resources[0].endpoint,'/Users');
    assert.equal((await (await request('/Schemas/'+encodeURIComponent(USER_SCHEMA))).json()).id,USER_SCHEMA);
    const created=await request('/Users','POST',{schemas:[USER_SCHEMA],userName:'new-user'});assert.equal(created.status,201);assert.match(created.headers.get('content-type'),/application\/scim\+json/);const user=await created.json();assert.equal(created.headers.get('etag'),user.meta.version);
    const denied=await request('/Users','GET',undefined,'test-reader');assert.equal(denied.status,403);assert.equal((await denied.json()).status,'403');
    const updated=await request('/Users/'+user.id,'PATCH',patch([{op:'replace',path:'active',value:false}]),'test-owner',{'If-Match':user.meta.version});assert.equal(updated.status,200);assert.equal((await updated.json()).active,false);
    const stale=await request('/Users/'+user.id,'PUT',{userName:'new-user'},'test-owner',{'If-Match':user.meta.version});assert.equal(stale.status,412);
    const deleted=await request('/Users/'+user.id,'DELETE');assert.equal(deleted.status,204);assert.equal(await deleted.text(),'');
    assert.equal((await request('/Users/'+user.id)).status,404);
    assert.equal((await request('/Users','GET',undefined,'invalid')).status,401);
  } finally {await new Promise(resolve=>server.close(resolve));store.close();}
});
