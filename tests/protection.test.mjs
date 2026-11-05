import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeepSeekWebClient } from '../lib/deepseek-web/client.js'
import { AccountRequestGate, retryAfterMs } from '../lib/local/request-gate.js'
import { digest } from '../lib/local/store.js'
import { TokenFreeError } from '../lib/core/errors.js'
async function fixture(fn) { const home = await mkdtemp(join(tmpdir(), 'tokenfree-protection-')); try { await fn(home) } finally { await rm(home, { recursive: true, force: true }) } }
test('persisted manual pause blocks even identity before the fetch hook runs', () => fixture(async home => {
 await writeFile(join(home,'network-protection.json'),JSON.stringify({version:1,paused:{reason:'manual',at:Date.now()},until:0,requests:[],policy:{http10m:100,httpDay:500,generation10m:20,generationDay:100}}),{mode:0o600})
 let calls=0
 const client=new DeepSeekWebClient({token:'fixture-token'},{protectionHome:home,fetch:async()=>{calls++;return Response.json({code:0,data:{biz_code:0,biz_data:{id:'fixture'}}})}})
 await assert.rejects(client.identity(new AbortController().signal),e=>e.code==='ACCOUNT_PAUSED')
 assert.equal(calls,0)
}))
test('48 hour Retry-After is preserved by both parser and persisted account cooldown',()=>fixture(async home=>{
 assert.equal(retryAfterMs('172800',0),172800000)
 const lease=await new AccountRequestGate(home,digest('fixture'),{intervalMs:0,cooldownMs:10,maxCooldownMs:20}).enter(new AbortController().signal)
 try { const start=Date.now();await lease.failed(new TokenFreeError('limit','RATE_LIMIT',{retryAfterMs:172800000}));
 const {readFile}=await import('node:fs/promises');const saved=JSON.parse(await readFile(join(home,'requests',digest('fixture')+'.json'),'utf8'));assert(saved.until>=start+172800000)
 } finally {await lease.release()}
}))

test('pause blocks browser launch, login, recovery and cached credentials without losing saved login',()=>fixture(async home=>{
 const {NetworkProtection}=await import('../lib/local/network-protection.js');const {LocalAccount}=await import('../lib/core/account.js');const {ManagedBrowserLogin}=await import('../lib/deepseek-web/browser-login.js');const {LocalStore}=await import('../lib/local/store.js')
 const file=join(home,'credentials.json'),store=new LocalStore(home);await store.saveLogin(file,{token:'fixture-token',accountId:'fixture'},(await store.account()).epoch)
 let checks=0,launches=0;const browser=new ManagedBrowserLogin(join(home,'browser-profile'),{launch:async()=>{launches++;throw Error('must not launch')},check:async()=>{checks++}})
 const account=new LocalAccount(file,{browser,check:async()=>{checks++}})
 try {
  await account.credential(new AbortController().signal);assert.equal(checks,1);const before=await store.credential(file)
  await new NetworkProtection(home).pause()
  await assert.rejects(browser.obtain({interactive:true,signal:new AbortController().signal}),e=>e.code==='ACCOUNT_PAUSED')
  await assert.rejects(account.credential(new AbortController().signal),e=>e.code==='ACCOUNT_PAUSED')
  await account.restore();account.login();while(account.status().busy)await new Promise(r=>setTimeout(r,5))
  assert.equal(launches,0);assert.equal(checks,1);assert.deepEqual(await store.credential(file),before)
  assert.equal((await account.refreshLocalStatus()).protection.paused,true)
 } finally {await account.dispose()}
}))

test('HTTP and generation budgets are shared, survive restart, count failures and do not reset on resume',()=>fixture(async home=>{
 const {NetworkProtection}=await import('../lib/local/network-protection.js');let now=100000000,calls=0
 const a=new NetworkProtection(home,()=>now),b=new NetworkProtection(home,()=>now)
 await a.setPolicy({http10m:4,httpDay:5,generation10m:2,generationDay:3})
 const send=async()=>{calls++;return 'ok'},signal=new AbortController().signal
 await a.run('/api/v0/chat/completion',signal,send);await b.run('/api/v0/chat/edit_message',signal,send)
 await assert.rejects(a.run('/api/v0/chat/completion',signal,send),e=>e.code==='REQUEST_BUDGET')
 assert.equal(calls,2);assert.equal((await b.status()).paused,true)
 await assert.rejects(b.resume(false),e=>e.code==='ACCOUNT_PAUSED');await b.resume(true)
 await assert.rejects(a.run('/api/v0/chat/edit_message',signal,send),e=>e.code==='REQUEST_BUDGET');assert.equal(calls,2)
 now+=600001;await b.resume(true)
 await assert.rejects(a.run('/identity',signal,async()=>{calls++;throw Error('offline')}))
 await b.run('/settings',signal,send);await b.run('/history',signal,send)
 await assert.rejects(a.run('/identity',signal,send),e=>e.code==='REQUEST_BUDGET');assert.equal(calls,5)
 now+=86400001;await a.resume(true);await b.run('/identity',signal,send);assert.equal(calls,6)
}))

test('concurrent clients cannot overspend one HTTP budget; corrupt protection fails closed and is preserved',()=>fixture(async home=>{
 const {NetworkProtection}=await import('../lib/local/network-protection.js');const {readFile}=await import('node:fs/promises');let calls=0
 const a=new NetworkProtection(home),b=new NetworkProtection(home);await a.setPolicy({http10m:1,httpDay:2,generation10m:1,generationDay:1})
 const results=await Promise.allSettled([a,b].map(g=>g.run('/history',new AbortController().signal,async()=>++calls)))
 assert.equal(calls,1);assert.equal(results.filter(r=>r.status==='rejected').length,1)
 const path=join(home,'network-protection.json');await writeFile(path,'{"version":1,"paused":false}',{mode:0o600})
 await assert.rejects(a.run('/history',new AbortController().signal,async()=>++calls),e=>e.code==='STATE_STORAGE')
 await assert.rejects(a.resume(true),e=>e.code==='STATE_STORAGE');assert.equal(calls,1);assert.equal(await readFile(path,'utf8'),'{"version":1,"paused":false}')
}))

test('server waits and rate limits persist, cannot be cleared early, and never auto-resume a paused account',()=>fixture(async home=>{
 const {NetworkProtection}=await import('../lib/local/network-protection.js');let now=100000000;const a=new NetworkProtection(home,()=>now)
 await a.observe(new Response('',{status:429,headers:{'retry-after':'172800'}}))
 assert.equal((await a.status()).until,now+172800000);await assert.rejects(a.resume(true),e=>e.code==='ACCOUNT_COOLDOWN')
 now+=172800001;await assert.rejects(a.check(new AbortController().signal),e=>e.code==='ACCOUNT_PAUSED');await a.resume(true);await a.check(new AbortController().signal)
 await a.observe(new Response('',{status:503,headers:{'retry-after':'999999999999999999999999999999999999999'}}))
 assert.equal((await a.status()).until,Number.MAX_SAFE_INTEGER);assert.equal((await a.status()).paused,true)
}))

test('paused client blocks every transport entry, including generation, metadata, files and pending recovery',()=>fixture(async home=>{
 const {NetworkProtection}=await import('../lib/local/network-protection.js');await new NetworkProtection(home).pause();let calls=0
 const client=new DeepSeekWebClient({token:'fixture-token'},{protectionHome:home,fetch:async()=>{calls++;throw Error('network forbidden')}}),signal=new AbortController().signal
 const collect=async iterable=>{for await(const value of iterable)void value}
 for(const run of [()=>client.check(signal),()=>client.create(signal),()=>collect(client.generate('chat',null,'hello',false,signal)),()=>collect(client.editRoot('chat',1,'hello',false,signal)),()=>client.history('chat',signal),()=>client.settings('device',signal),()=>client.files(['file-fixture'],signal),()=>collect(client.resume({chatId:'chat',requestId:1,responseId:2},signal)),()=>client.stop({chatId:'chat',requestId:1,responseId:2},signal)])await assert.rejects(run(),e=>e.code==='ACCOUNT_PAUSED')
 assert.equal(calls,0)
}))

test('settings cache shares one request, retains fresh history, and a pause overrides cached settings',()=>fixture(async home=>{
 const {NetworkProtection}=await import('../lib/local/network-protection.js');let settings=0,history=0
 const fetch=async url=>{if(url.includes('settings')){settings++;await new Promise(r=>setTimeout(r,20));return Response.json({code:0,data:{biz_code:0,biz_data:{version:1,settings:{model_configs:{value:[{model_type:'default',file_feature:{token_limit:100}}]}}}}})}history++;return Response.json({code:0,data:{biz_code:0,biz_data:{cache_control:'REPLACE',chat_messages:[]}}})}
 const clients=[1,2].map(()=>new DeepSeekWebClient({token:'fixture-token'},{fetch,protectionHome:home})),signal=new AbortController().signal
 const values=await Promise.all(clients.map(c=>c.settings('device',signal)));assert.equal(settings,1);assert.deepEqual(values[0],values[1])
 values[0].models[0].tokenLimit=999;assert.equal((await clients[0].settings('device',signal)).models[0].tokenLimit,100)
 await Promise.all(clients.map(c=>c.history('chat',signal)));assert.equal(history,2)
 await new NetworkProtection(home).pause();await assert.rejects(clients[0].settings('device',signal),e=>e.code==='ACCOUNT_PAUSED');assert.equal(settings,1)
}))

test('pause after proof preparation prevents the separate multipart send',()=>fixture(async home=>{
 const {NetworkProtection}=await import('../lib/local/network-protection.js');const {createHash}=await import('node:crypto');let calls=0
 const data=new Uint8Array([1]),ref={attachmentId:'sha256:'+createHash('sha256').update(data).digest('hex'),mediaType:'image/png',bytes:1,width:1,height:1,name:'fixture.png'}
 const client=new DeepSeekWebClient({token:'fixture-token'},{protectionHome:home,fetch:async()=>{calls++;return Response.json({code:0,data:{biz_code:0,biz_data:{challenge:{algorithm:'DeepSeekHashV1',challenge:'fixture',salt:'fixture',difficulty:1,expire_at:9999999999,signature:'fixture',target_path:'/api/v0/file/upload_file'}}}})},solve:async()=>{await new NetworkProtection(home).pause();return 'fixture-proof'}})
 await assert.rejects(client.uploadImage({ref,data},false,new AbortController().signal),e=>e.code==='ACCOUNT_PAUSED'&&e.details.accepted===false)
 assert.equal(calls,1)
}))

test('settings failures are not cached; expiry and identity changes fetch new settings',()=>fixture(async home=>{
 const {mock}=await import('node:test');let calls=0
 mock.timers.enable({apis:['Date'],now:Date.now()})
 const fetch=async()=>{calls++;if(calls===1)return Response.json({unexpected:true});return Response.json({code:0,data:{biz_code:0,biz_data:{version:calls,settings:{model_configs:{value:[]}}}}})}
 const make=token=>new DeepSeekWebClient({token},{fetch,protectionHome:home}),a=make('one'),signal=new AbortController().signal
 try {
  await assert.rejects(a.settings('device',signal),e=>e.code==='WEB_PROTOCOL')
  assert.equal((await a.settings('device',signal)).version,2);assert.equal((await a.settings('device',signal)).version,2)
  mock.timers.tick(60001);assert.equal((await a.settings('device',signal)).version,3)
  assert.equal((await make('two').settings('device',signal)).version,4)
  assert.equal((await a.settings('another-device',signal)).version,5)
 } finally {mock.timers.reset()}
}))

test('protection controls through CLI are local, require confirmation and retain counters and credentials',()=>fixture(async home=>{
 const {spawnSync}=await import('node:child_process');const {readFile}=await import('node:fs/promises');const file=join(home,'credentials.json');await writeFile(file,'{"token":"fixture-private-token"}',{mode:0o600})
 const cli=(...args)=>spawnSync(process.execPath,['lib/cli.js','protection',...args],{encoding:'utf8',env:{...process.env,DSH_TOKENFREE_HOME:home}})
 let result=cli('pause');assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).paused,true)
 result=cli('resume');assert.equal(result.status,1);assert.match(result.stderr,/ACCOUNT_PAUSED/)
 result=cli('resume','--confirm-unblocked');assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).paused,false)
 assert.equal(await readFile(file,'utf8'),'{"token":"fixture-private-token"}')
}))

test('proof asset download also respects the persistent pause and never resets it',()=>fixture(async home=>{
 const {NetworkProtection}=await import('../lib/local/network-protection.js');const {loadWasm}=await import('../lib/deepseek-web/pow.js');await new NetworkProtection(home).pause();let calls=0
 await assert.rejects(loadWasm(new AbortController().signal,{protectionHome:home,fetch:async()=>{calls++;throw Error('forbidden')}}),e=>e.code==='ACCOUNT_PAUSED')
 assert.equal(calls,0)
}))

test('protection budgets apply across independent processes',()=>fixture(async home=>{
 const {NetworkProtection}=await import('../lib/local/network-protection.js');const {spawn}=await import('node:child_process')
 await new NetworkProtection(home).setPolicy({http10m:2,httpDay:2,generation10m:2,generationDay:2})
 const module=new URL('../lib/local/network-protection.js',import.meta.url).href
 const code=`import {NetworkProtection} from ${JSON.stringify(module)};try{await new NetworkProtection(process.argv[1]).run('/api/v0/chat/completion',new AbortController().signal,async()=>console.log('sent'))}catch(e){console.log(e.code)}`
 const results=await Promise.all([1,2,3].map(()=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,['--input-type=module','-e',code,home],{stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.on('error',reject);child.on('close',status=>status===0?resolve(out.trim()):reject(Error(err)))})))
 assert.equal(results.filter(x=>x==='sent').length,2);assert.equal(results.filter(x=>x==='REQUEST_BUDGET').length,1)
 const state=await new NetworkProtection(home).status();assert.equal(state.httpDay,2);assert.equal(state.generationDay,2);assert.equal(state.paused,true)
}))

test('a protection write failure after sending cannot claim that generation was never accepted',()=>fixture(async home=>{
 const {NetworkProtection}=await import('../lib/local/network-protection.js');let calls=0
 const client=new DeepSeekWebClient({token:'fixture-token'},{protectionHome:home,solve:async()=> 'fixture-proof',fetch:async url=>{
  calls++;if(url.endsWith('/create_pow_challenge'))return Response.json({code:0,data:{biz_code:0,biz_data:{challenge:{algorithm:'DeepSeekHashV1',challenge:'fixture',salt:'fixture',difficulty:1,expire_at:9999999999,signature:'fixture'}}}})
  await writeFile(join(home,'network-protection.json'),'broken',{mode:0o600});return new Response('uncertain',{headers:{'retry-after':'1'}})
 }})
 await assert.rejects(async()=>{for await(const value of client.generate('chat',null,'hello',false,new AbortController().signal))void value},e=>e.code==='STATE_STORAGE'&&e.details?.accepted!==false)
 assert.equal(calls,2);await assert.rejects(new NetworkProtection(home).check(new AbortController().signal),e=>e.code==='STATE_STORAGE')
}))

test('offline guard rejects remote fetch, sockets and browser launch before any connection',()=>fixture(async home=>{
 const {spawnSync}=await import('node:child_process');const {readFile}=await import('node:fs/promises');const log=join(home,'guard-negative.txt')
 const code=`import net from 'node:net';import {spawn} from 'node:child_process';let blocked=0;for(const fn of [()=>fetch('https://chat.deepseek.com/api/v0/users/current'),()=>net.connect({host:'192.0.2.1',port:443}),()=>spawn('/fixture/Google Chrome',[])])try{await fn()}catch(e){if(!e.message.includes('Offline validation blocked'))throw e;blocked++}if(blocked!==3)throw Error('guard missed a boundary')`
 const result=spawnSync(process.execPath,['--import',new URL('../scripts/offline-guard.mjs',import.meta.url).pathname,'--input-type=module','-e',code],{encoding:'utf8',env:{...process.env,DSH_OFFLINE_VIOLATIONS:log}})
 assert.equal(result.status,0,result.stderr);assert.deepEqual((await readFile(log,'utf8')).trim().split('\n'),['remote fetch','remote socket','browser launch'])
}))

test('browser request routing preserves prior handlers and blocks navigation after a cross-instance pause',()=>fixture(async home=>{
 const {NetworkProtection}=await import('../lib/local/network-protection.js');const {ManagedBrowserLogin}=await import('../lib/deepseek-web/browser-login.js')
 let handler,continued=0,aborted=0,closed=false,checks=0
 const route=()=>({request:()=>({url:()=> 'https://chat.deepseek.com/sign_in'}),fallback:async()=>{continued++},abort:async()=>{aborted++}})
 const page={isClosed:()=>closed,url:()=> 'https://chat.deepseek.com/',bringToFront:async()=>{},goto:async()=>{await handler(route());await new NetworkProtection(home).pause();await handler(route())},evaluate:async()=> 'fixture'}
 const context={pages:()=>[page],cookies:async()=>[],route:async(_pattern,fn)=>{handler=fn},on:()=>{},close:async()=>{closed=true}}
 const browser=new ManagedBrowserLogin(join(home,'browser-profile'),{launch:async()=>context,check:async()=>{checks++}})
 try {await assert.rejects(browser.obtain({interactive:true,signal:AbortSignal.timeout(5000)}),e=>e.code==='ACCOUNT_PAUSED');assert.equal(continued,1);assert.equal(aborted,1);assert.equal(checks,0);assert.equal(closed,true)}finally{await browser.close()}
}))
