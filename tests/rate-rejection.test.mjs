import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setup, input, collect, frame, sse } from './helpers/fixture.mjs'
import { LocalDiagnostics } from '../lib/local/diagnostics.js'
import { decodeResponse } from '../lib/core/codec.js'
import { loggedRateRejection } from '../lib/local/rate-rejection.js'
const hint={type:'error',content:'消息发送过于频繁，请稍后重试',clear_response:true,finish_reason:'rate_limit_reached'}
test('explicit rejection with absent official request retries only the refused generation and commits once',async()=>{
 const f=await setup();try{
  f.web.completion=({ready,body,text})=>{if(f.web.generations.length===1){f.web.chats.set(body.chat_session_id,[]);return sse(ready+frame(hint,'hint'))}return sse(ready+frame({v:{response:{status:'FINISHED',fragments:[{type:'RESPONSE',content:text}]}}}))}
  const result=(await f.run()).find(e=>e.type==='result');assert(result)
  assert.equal(f.web.stops.length,0);assert.equal(f.web.generations.length,2)
  f.native.save(result);await f.engine.reconcile('session-1');assert.equal(await f.pending(),undefined)
 }finally{await f.close()}
})
test('legacy rate-limit journal requires exact control, request identity, durable failed native attempt and unchanged official parent',async()=>{
 const f=await setup(home=>new LocalDiagnostics(home,false));try{
  // Build a real private journal, then represent the older version without a rejection marker.
  f.web.completion=({ready})=>sse(ready+frame(hint,'hint'))
  await assert.rejects(f.run(),e=>e.code==='RATE_LIMIT');await f.log.flush()
  const op=await f.pending();assert(op);assert.equal(await loggedRateRejection(f.home,op),true)
  const file=join(f.home,'sessions',op.sessionKey+'.json'),state=JSON.parse(await readFile(file,'utf8'))
  delete state.active.rateRejected;delete state.active.verifiedPath;delete state.active.knownRejected;state.active.stage='uncertain'
  await writeFile(file,JSON.stringify(state),{mode:0o600});f.web.chats.set(op.chatId,[])
  f.native.cancel(op.native)
  const before=f.web.generations.length
  assert.equal(await f.engine.verifyPending(f.accountKey,f.web.client(),AbortSignal.timeout(1000),'session-1',op.id),true)
  assert.equal(await f.pending(),undefined);assert.equal(f.web.generations.length,before)
  // The journal is not accepted when ids/hash/native identity or output evidence differs.
  for(const changed of [{...op,identity:{...op.identity,responseId:999}},{...op,promptHash:'a'.repeat(64)},{...op,native:{...op.native,step:99}}])assert.equal(await loggedRateRejection(f.home,changed),false)
  const journal=join(f.log.contentDirectory,op.id+'.jsonl'),raw=await readFile(journal,'utf8')
  const row=JSON.parse(raw.split('\n').find(x=>x.includes('"web.event"')))
  row.payload={name:'update',step:0,resume:0,data:{v:{response:{fragments:[{type:'RESPONSE',content:'some output'}]}}}}
  await writeFile(journal,raw+JSON.stringify(row)+'\n',{mode:0o600});assert.equal(await loggedRateRejection(f.home,op),false)
 }finally{await f.close()}
})
