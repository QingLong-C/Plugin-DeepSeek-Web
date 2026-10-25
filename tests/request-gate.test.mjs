import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { AccountRequestGate, retryAfterMs } from '../lib/local/request-gate.js'
import { TokenFreeError } from '../lib/core/errors.js'
import { digest } from '../lib/local/store.js'
const policy = { intervalMs: 35, cooldownMs: 70, maxCooldownMs: 280 }
const account = digest('owner')
async function fixture(fn) { const home = await mkdtemp(join(tmpdir(), 'tokenfree-gate-')); try { await fn(home) } finally { await rm(home, { recursive:true, force:true }) } }
test('same account is FIFO across gate instances, different accounts remain independent', () => fixture(async home => {
 const a = new AccountRequestGate(home, account, policy), b = new AccountRequestGate(home, account, policy)
 const first = await a.enter(new AbortController().signal), order=[]
 const second = b.enter(new AbortController().signal).then(async lease=>{order.push(2);await lease.release()})
 while((await readdir(join(home,'locks','request-'+account))).filter(x=>x.endsWith('.json')).length<2)await delay(5)
 await delay(30)
 const third = a.enter(new AbortController().signal).then(async lease=>{order.push(3);await lease.release()})
 const other = await new AccountRequestGate(home,digest('other'),policy).enter(AbortSignal.timeout(1000)); await other.release()
 assert.deepEqual(order,[]); await first.release(); await Promise.all([second,third]);assert.deepEqual(order,[2,3])
}))
test('cancelled queue wait removes its ticket and never acquires the account',()=>fixture(async home=>{
 const gate=new AccountRequestGate(home,account,policy), first=await gate.enter(AbortSignal.timeout(2000)), cancel=new AbortController()
 const queued=gate.enter(cancel.signal);cancel.abort();await assert.rejects(queued);await first.release()
 const last=await gate.enter(AbortSignal.timeout(1000));await last.release()
}))
test('cooldown survives recreation, doubles on consecutive rate limits, and Retry-After is a lower bound',()=>fixture(async home=>{
 const gate=new AccountRequestGate(home,account,policy), first=await gate.enter(AbortSignal.timeout(2000))
 await first.submission(AbortSignal.timeout(1000)); await first.failed(new TokenFreeError('limit','RATE_LIMIT',{retryAfterMs:100}));await first.release()
 const before=JSON.parse(await readFile(join(home,'requests',account+'.json'),'utf8'));const second=await new AccountRequestGate(home,account,policy).enter(AbortSignal.timeout(2000))
 assert(Date.now()>=before.until); const failedAt=Date.now();await second.failed(new TokenFreeError('limit','RATE_LIMIT'));await second.release()
 const state=JSON.parse(await readFile(join(home,'requests',account+'.json'),'utf8'));assert.equal(state.strikes,2);assert(state.until>=failedAt+140)
 const cancel=new AbortController(), wait=gate.enter(cancel.signal);setTimeout(()=>cancel.abort(),10);await assert.rejects(wait)
}))
test('all submissions including correction share pacing; success clears backoff, auth and transport do not trigger rate retries',()=>fixture(async home=>{
 const gate=new AccountRequestGate(home,account,policy), lease=await gate.enter(AbortSignal.timeout(2000))
 await lease.submission(AbortSignal.timeout(2000));const start=Date.now();await lease.submission(AbortSignal.timeout(2000));assert(Date.now()-start>=25)
 await lease.failed(new TokenFreeError('network','TRANSPORT'));await lease.succeeded();await lease.release()
 const state=JSON.parse(await readFile(join(home,'requests',account+'.json'),'utf8'));assert.equal(state.strikes,0);assert.equal(state.until,0)
}))
test('Retry-After accepts seconds and future dates, rejects malformed/negative/non-finite and bounds huge hints',()=>{
 assert.equal(retryAfterMs('2',0),2000);assert.equal(retryAfterMs('Thu, 01 Jan 1970 00:00:03 GMT',1000),2000)
 for(const value of [null,'no','-2','Infinity','1.5'])assert.equal(retryAfterMs(value,0),undefined)
 assert.equal(retryAfterMs('99999999999',0),86400000)
})

test('cross-process account owner blocks followers and a crashed owner is recovered without clearing cooldown',()=>fixture(async home=>{
 const module=new URL('../lib/local/request-gate.js',import.meta.url).href
 const code=`import {AccountRequestGate} from ${JSON.stringify(module)}; const gate=new AccountRequestGate(process.argv[1],process.argv[2],{intervalMs:0,cooldownMs:60,maxCooldownMs:120});const lease=await gate.enter(new AbortController().signal);console.log('owned');setInterval(()=>{},1000)`
 const child=spawn(process.execPath,['--input-type=module','-e',code,home,account],{stdio:['ignore','pipe','pipe']})
 try{
  const [data]=await once(child.stdout,'data');assert.equal(data.toString().trim(),'owned')
  const gate=new AccountRequestGate(home,account,policy);let entered=false
  const pending=gate.enter(AbortSignal.timeout(3000)).then(lease=>{entered=true;return lease})
  await delay(40);assert.equal(entered,false);const exited=once(child,'exit');child.kill('SIGKILL');await exited
  const lease=await pending;await lease.release();assert.equal(entered,true)
 }finally{if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGKILL');await exited}}
}))

test('damaged cooldown is preserved and refused instead of silently dropping the pause',()=>fixture(async home=>{
 const gate=new AccountRequestGate(home,account,policy), lease=await gate.enter(AbortSignal.timeout(1000));await lease.submission(AbortSignal.timeout(1000));await lease.release()
 const path=join(home,'requests',account+'.json');await writeFile(path,'{"version":1,"until":-1}',{mode:0o600})
 await assert.rejects(gate.enter(AbortSignal.timeout(1000)),e=>e.code==='STATE_STORAGE');assert.equal(await readFile(path,'utf8'),'{"version":1,"until":-1}')
}))
