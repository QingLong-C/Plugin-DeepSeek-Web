import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NetworkProtection } from '../lib/local/network-protection.js'
import { DeepSeekWebClient } from '../lib/deepseek-web/client.js'
import { LocalAccount } from '../lib/core/account.js'
import { LocalStore } from '../lib/local/store.js'
async function fixture(fn) { const home=await mkdtemp(join(tmpdir(),'tokenfree-login-only-'));try{await fn(home)}finally{await rm(home,{recursive:true,force:true})} }
const signal=()=>AbortSignal.timeout(5000)
async function loginOnly(home) { await writeFile(join(home,'network-protection.json'),JSON.stringify({version:1,mode:'login-only',until:0,requests:[],policy:{http10m:100,httpDay:500,generation10m:20,generationDay:100}}),{mode:0o600}) }
test('login-only mode blocks every automatic transport while allowing explicit login identity only',()=>fixture(async home=>{
 await loginOnly(home);let calls=0
 const fetch=async()=>{calls++;return Response.json({code:0,data:{biz_code:0,biz_data:{id:'fixture'}}})}
 const client=new DeepSeekWebClient({token:'fixture-token'},{protectionHome:home,fetch}),login=new DeepSeekWebClient({token:'fixture-token'},{protectionHome:home,login:true,fetch})
 for(const run of [()=>client.identity(signal()),()=>client.history('chat',signal()),()=>client.settings('did',signal()),()=>login.history('chat',signal())])await assert.rejects(run(),e=>e.code==='ACCOUNT_LOGIN_ONLY')
 assert.equal(calls,0);assert.equal(await login.identity(signal()),'fixture');assert.equal(calls,1)
 assert.equal(JSON.parse(await readFile(join(home,'network-protection.json'),'utf8')).mode,'login-only')
}))
test('login-only settings restore and cached credentials stay offline; manual login persists then stops',()=>fixture(async home=>{
 const store=new LocalStore(home),file=join(home,'credentials.json');await store.saveLogin(file,{token:'old-fixture',accountId:'fixture'},(await store.account()).epoch)
 await loginOnly(home);let checks=0,browsers=0
 const account=new LocalAccount(file,{check:async()=>{checks++},browser:{obtain:async()=>{browsers++;return {token:'new-fixture',accountId:'fixture'}},close:async()=>{}}})
 try {
  const view=await account.restore();assert.equal(checks,0);assert.equal(browsers,0);assert.equal(view.protection.mode,'login-only')
  await assert.rejects(account.credential(signal()),e=>e.code==='ACCOUNT_LOGIN_ONLY')
  account.login();while(account.status().busy)await new Promise(r=>setTimeout(r,5))
  assert.equal(account.status().state,'connected');assert.equal(checks,1);assert.equal(browsers,1);assert.equal((await store.credential(file)).token,'new-fixture')
  await account.restore();await account.refreshLocalStatus();assert.equal(checks,1);assert.equal(browsers,1)
  await assert.rejects(account.credential(signal()),e=>e.code==='ACCOUNT_LOGIN_ONLY');assert.equal((await new NetworkProtection(home).status()).mode,'login-only')
 }finally{await account.dispose()}
}))

test('login-only mode persists across CLI and restart, and pause cannot be bypassed by login',()=>fixture(async home=>{
 const {spawnSync}=await import('node:child_process');const cli=(...args)=>spawnSync(process.execPath,['lib/cli.js','protection',...args],{env:{...process.env,DSH_TOKENFREE_HOME:home},encoding:'utf8'})
 const set=cli('login-only');assert.equal(set.status,0,set.stderr);assert.equal(JSON.parse(set.stdout).mode,'login-only')
 const denied=cli('normal');assert.equal(denied.status,1);assert.match(denied.stderr,/ACCOUNT_LOGIN_ONLY/)
 const protection=new NetworkProtection(home);await protection.pause();await assert.rejects(protection.run('/api/v0/users/current',signal(),async()=>{assert.fail('must not send')},true),e=>e.code==='ACCOUNT_PAUSED')
 assert.equal((await new NetworkProtection(home).status()).mode,'login-only')
}))

test('HTTP 200 SSE rate-limit or busy refusal pauses further account requests',()=>fixture(async home=>{
 for(const reason of ['rate_limit_reached','backend_busy']) {
  const directory=join(home,reason);let calls=0
  const fetch=async url=>{calls++;return url.endsWith('/create_pow_challenge')?Response.json({code:0,data:{biz_code:0,biz_data:{challenge:{algorithm:'DeepSeekHashV1',challenge:'fixture',salt:'fixture',signature:'fixture',difficulty:1,expire_at:1}}}}):new Response(`event: hint\ndata: ${JSON.stringify({type:'error',clear_response:true,finish_reason:reason})}\n\n`,{headers:{'content-type':'text/event-stream'}})}
  const client=new DeepSeekWebClient({token:'fixture-token'},{protectionHome:directory,fetch,solve:async()=> 'fixture'})
  await assert.rejects(async()=>{for await(const event of client.generate('chat',null,'fixture',false,signal()))void event},e=>['RATE_LIMIT','WEB_BUSY'].includes(e.code))
  assert.equal((await new NetworkProtection(directory).status()).paused,true)
  await assert.rejects(client.history('chat',signal()),e=>e.code==='ACCOUNT_PAUSED');assert.equal(calls,2)
 }
}))

test('manual login blocks background chat requests without cancelling the login page',()=>fixture(async home=>{
 await loginOnly(home);const {ManagedBrowserLogin}=await import('../lib/deepseek-web/browser-login.js');let handler,aborts=0,continued=0,checks=0,closed=false
 const route=path=>({request:()=>({url:()=> 'https://chat.deepseek.com'+path}),fallback:async()=>{continued++},abort:async()=>{aborts++}})
 const page={url:()=> 'https://chat.deepseek.com/sign_in',isClosed:()=>closed,bringToFront:async()=>{},evaluate:async()=> 'fixture-token',goto:async()=>{await handler(route('/sign_in'));await handler(route('/api/v0/chat/history_messages'));await handler(route('/api/v0/client/settings'))}}
 const context={pages:()=>[page],cookies:async()=>[],route:async(_pattern,fn)=>{handler=fn},on:()=>{},close:async()=>{closed=true}}
 const browser=new ManagedBrowserLogin(join(home,'browser-profile'),{launch:async()=>context,check:async()=>{checks++}})
 try {
  await assert.rejects(browser.obtain({interactive:false,signal:signal()}),e=>e.code==='ACCOUNT_LOGIN_ONLY')
  const credential=await browser.obtain({interactive:true,signal:signal()});assert.equal(credential.token,'fixture-token');assert.equal(aborts,2);assert.equal(continued,1);assert.equal(checks,1);assert.equal(closed,true)
 }finally{await browser.close()}
}))
