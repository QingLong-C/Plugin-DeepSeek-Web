import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { setup, input, collect, frame, snapshot, sse } from './helpers/fixture.mjs'
import { decodeResponse } from '../lib/core/codec.js'
import { LocalStore } from '../lib/local/store.js'
import { TokenFreeError } from '../lib/core/errors.js'
import { TokenFreeAdapter } from '../lib/dsh/adapter.js'

const hint = { type: 'error', clear_response: true, finish_reason: 'rate_limit_reached' }
function reject(f, context, mode = 'sse') {
  f.web.chats.set(context.body.chat_session_id, f.web.chats.get(context.body.chat_session_id).filter(m => ![context.requestId, context.responseId].includes(m.message_id)))
  return mode === 'http' ? new Response('', { status: 429 }) : sse(context.ready + frame(hint, 'hint'))
}
for (const mode of ['sse', 'http']) test(`${mode} rejection automatically waits and completes the same native attempt and prompt`, async () => {
  const f = await setup(); const times = [], states = []
  try {
    f.web.completion = async context => {
      times.push(Date.now()); states.push(await f.pending())
      return times.length < 3 ? reject(f, context, mode) : sse(context.ready + frame(snapshot(context.text)))
    }
    const events = await f.run(), result = events.find(e => e.type === 'result')
    assert(result); assert.equal(times.length, 3)
    assert(times[1] - times[0] >= 5); assert(times[2] - times[1] >= 10)
    assert.equal(new Set(states.map(s => s.id)).size, 1); assert.equal(new Set(states.map(s => s.native.attemptId)).size, 1)
    assert.equal(new Set(f.web.generations.map(g => g.prompt)).size, 1)
    assert.equal(new Set(f.web.generations.map(g => g.parent_message_id)).size, 1)
    assert.equal(events.filter(e => e.type === 'withdraw').length, 0)
    assert.equal(f.web.resumes.length, 0); assert.equal(f.web.stops.length, 0)
    f.native.save(result); await f.engine.reconcile(); assert.equal(await f.pending(), undefined)
    const gate = JSON.parse(await readFile(join(f.home, 'requests', f.accountKey + '.json'), 'utf8'))
    assert.equal(gate.strikes, 0)
  } finally { await f.close() }
})
test('cooldown exceeds the generation timeout without timing out the waiting task', async () => {
  const f = await setup()
  try {
    // LocalStore has a constructor-level test policy, rather than a production timing override.
    const store = new LocalStore(f.home, { intervalMs: 0, cooldownMs: 650, maxCooldownMs: 650 })
    const { SessionEngine } = await import('../lib/core/session.js')
    const engine = new SessionEngine({ store, storeId: 'fixture-store', native: f.native, maxPromptChars: 120000 })
    let calls = 0
    f.web.completion = context => ++calls === 1 ? reject(f, context, 'http') : sse(context.ready + frame(snapshot(context.text)))
    const i = input(); f.native.begin(i.sessionId)
    const events = await collect(engine.run(i, f.accountKey, f.web.client(), AbortSignal.timeout(2000), (text, id) => decodeResponse(text, [], id), undefined, undefined, undefined, 400))
    assert(events.some(e => e.type === 'result')); assert.equal(calls, 2)
  } finally { await f.close() }
})
test('cancel while cooling never resubmits and releases the account for other work', async () => {
  const f = await setup(); const controller = new AbortController()
  try {
    f.web.completion = context => { setTimeout(() => controller.abort(), 15); return reject(f, context, 'http') }
    const store = new LocalStore(f.home, { intervalMs: 0, cooldownMs: 200, maxCooldownMs: 200 })
    const { SessionEngine } = await import('../lib/core/session.js')
    const engine = new SessionEngine({ store, storeId: 'fixture-store', native: f.native, maxPromptChars: 120000 })
    const i = input(); f.native.begin(i.sessionId)
    await assert.rejects(collect(engine.run(i, f.accountKey, f.web.client(), controller.signal, (text, id) => decodeResponse(text, [], id))))
    await delay(35); assert.equal(f.web.generations.length, 1)
    const op = await f.pending(); assert(op.knownRejected); f.native.cancel(op.native); await engine.reconcile()
    f.web.completion = undefined
    assert((await f.run(input([], 'other-session'))).some(e => e.type === 'result'))
  } finally { await f.close() }
})

test('Retry-After is respected during automatic continuation', async () => {
 const f=await setup();let first
 try{
  f.web.completion=c=>{
   if(f.web.generations.length===1){first=Date.now();reject(f,c,'http');return new Response('',{status:429,headers:{'Retry-After':'1'}})}
   assert(Date.now()-first>=1000);return sse(c.ready+frame(snapshot(c.text)))
  }
  assert((await f.run()).some(e=>e.type==='result'));assert.equal(f.web.generations.length,2)
 }finally{await f.close()}
})
test('known create rejection and read-only history throttling wait without duplicating a generation',async()=>{
 const f=await setup();let creates=0,histories=0;const original=f.web.fetch
 try{
  f.web.fetch=(url,options)=>{
   if(new URL(url).pathname.endsWith('/chat_session/create')&&++creates===1)return new Response('',{status:429})
   if(new URL(url).pathname.endsWith('/history_messages')&&++histories===1)return new Response('',{status:429})
   return original(url,options)
  }
  assert((await f.run()).some(e=>e.type==='result'));assert.equal(creates,2);assert.equal(histories,2)
  assert.equal(f.web.generations.length,1);assert.equal(f.web.chats.size,1)
 }finally{await f.close()}
})
test('normal pressure refresh retries read-only rate limits without repeating any generation',async()=>{
 const f=await setup();const a=new TokenFreeAdapter({sessionStoreId:'pressure-rate'},{store:f.store,native:f.native,credential:async()=>({token:'fixture',accountId:'fixture-owner'}),client:()=>f.web.client()})
 try{
  const e=await a.engine(),i=input();f.native.begin(i.sessionId)
  const result=(await collect(e.run(i,f.accountKey,f.web.client(),AbortSignal.timeout(3000),(text,id)=>decodeResponse(text,[],id)))).find(x=>x.type==='result')
  f.native.save(result);await e.reconcile()
  let reads=0;const original=f.web.fetch;f.web.fetch=(url,options)=>new URL(url).pathname.endsWith('/history_messages')&&++reads===1?new Response('',{status:429}):original(url,options)
  const metrics=await a.refreshMetrics(i.sessionId,true,AbortSignal.timeout(3000))
  assert.equal(reads,2);assert.equal(f.web.generations.length,1);assert(metrics)
 }finally{await a.dispose();await f.close()}
})
test('revocation while cooling aborts the same task without a second submission',async()=>{
 const f=await setup();let scheduled=false
 try{
  f.web.completion=c=>{if(!scheduled){scheduled=true;setTimeout(()=>{void f.store.revoke()},20)}return reject(f,c,'http')}
  const store=new LocalStore(f.home,{intervalMs:0,cooldownMs:600,maxCooldownMs:600})
  const{SessionEngine}=await import('../lib/core/session.js');const e=new SessionEngine({store,storeId:'fixture-store',native:f.native,maxPromptChars:120000})
  const i=input();f.native.begin(i.sessionId)
  await assert.rejects(collect(e.run(i,f.accountKey,f.web.client(),AbortSignal.timeout(3000),(text,id)=>decodeResponse(text,[],id))),x=>x.code==='ABORTED')
  assert.equal(f.web.generations.length,1)
 }finally{await f.close()}
})
test('SSE refusal without ready identity or with accepted history never triggers a new generation',async()=>{
 for(const mode of ['missing-ready','accepted-history','history-unavailable']){
  const f=await setup()
  try{
   f.web.completion=c=>{if(mode==='missing-ready')reject(f,c);if(mode==='history-unavailable')f.web.historyHook=()=>{throw new TokenFreeError('offline','TRANSPORT')};return sse((mode==='missing-ready'?'':c.ready)+frame(hint,'hint'))}
   await assert.rejects(f.run());assert.equal(f.web.generations.length,1)
  }finally{await f.close()}
 }
})
test('a changed confirmed parent prevents automatic continuation',async()=>{
 const f=await setup()
 try{
  const i=input(),first=(await f.run(i)).find(e=>e.type==='result'),assistant=f.native.save(first);await f.engine.reconcile()
  f.web.completion=c=>{reject(f,c);f.web.chats.get(c.body.chat_session_id).find(m=>m.message_id===first.operation.identity.responseId).fragments[0].content='changed elsewhere';return sse(c.ready+frame(hint,'hint'))}
  await assert.rejects(f.run(input([...i.messages,assistant,{id:'next',role:'user',content:[{type:'text',text:'next'}]}])))
  assert.equal(f.web.generations.length,2)
 }finally{await f.close()}
})
