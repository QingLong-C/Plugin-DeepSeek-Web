import {test} from 'node:test'
import assert from 'node:assert/strict'
import {TokenFreeAdapter,PROVIDER,MODEL} from '../lib/dsh/adapter.js'
import {setup,collect} from './helpers/fixture.mjs'
const tool={name:'inspect',description:'Inspect existing artifact',parameters:{type:'object',additionalProperties:false,properties:{label:{type:'string'}},required:['label']}}
const wrap=(p,label)=>({protocol_version:1,request_id:p.request_id,kind:'tool',calls:[{name:tool.name,arguments:{label}}]})
const options=()=>({provider:PROVIDER,model:MODEL,sessionId:'progress',messages:[{role:'user',content:[{type:'text',text:'Inspect existing artifact only'}]}],tools:[tool]})
const adapter=f=>new TokenFreeAdapter({}, {store:f.store,native:f.native,credential:async()=>({token:'fixture',accountId:'fixture-owner'}),client:(_,c)=>f.web.client(f.log,c.operationId)})

test('verified protocol-to-schema progress permits one final targeted correction, never another replan',async()=>{
 const f=await setup(),a=adapter(f),o=options();f.native.begin(o.sessionId)
 f.web.answer=(p,_,n)=>n===1?'damaged envelope':n===2?wrap(p,false):'<'+JSON.stringify({protocol_version:1,request_id:p.request_id,kind:'tool',calls:[{name:tool.name,arguments:{},label:'existing'}]})
 try{
  const chunks=await collect(a.stream(o));assert.equal(f.web.generations.length,3)
  assert.equal(chunks.filter(c=>c.block?.type==='tool-call').length,1)
  assert.deepEqual(JSON.parse(chunks.find(c=>c.block?.type==='tool-call').block.arguments),{label:'existing'})
  assert(f.web.generations[1].prompt.includes('DSH_PROTOCOL_CORRECTION_JSON:'))
  const feedback=JSON.parse(f.web.generations[2].prompt.split('TOOL_ARGUMENT_CORRECTION_JSON:\n')[1])
  assert.equal(feedback.attempt,2);assert.equal(feedback.errors[0].path,'/label');assert.equal(feedback.errors[0].rule,'type')
  const op=await f.store.pending((await a.engine()).key(o.sessionId));assert.equal(op.repair.attempt,2);assert.equal(op.repair.mode,'arguments')
 }finally{await a.dispose();await f.close()}
})

test('no-progress, schema-first, policy and exhausted refinements stop without delivering any tool',async()=>{
 for(const mode of ['repeat','different-syntax','schema-first','third-invalid','policy']){
  const f=await setup(),a=adapter(f),o=options(),chunks=[];f.native.begin(o.sessionId)
  if(mode==='policy')await a.setPolicy(o.sessionId,{tools:{mode:'none'},output:{type:'text'}})
  f.web.answer=(p,_,n)=>mode==='schema-first'?wrap(p,false):n===1?'damaged envelope':mode==='repeat'?'damaged envelope':mode==='different-syntax'?'another malformed protocol':wrap(p,false)
  try{
   await assert.rejects(async()=>{for await(const chunk of a.stream(o))chunks.push(chunk)},e=>/已自动纠正/.test(e.message))
   assert.equal(f.web.generations.length,mode==='third-invalid'?3:2,mode)
   assert.equal(chunks.some(c=>c.blockType==='tool-call'||c.type==='text-delta'),false,mode)
  }finally{await a.dispose();await f.close()}
 }
})

test('targeted refinement freezes valid calls and preserves the protocol replay guard',async()=>{
 for(const mode of ['valid','mutate-valid','narration','replay']){
  const f=await setup(),a=adapter(f),o=options(),chunks=[];f.native.begin(o.sessionId)
  if(mode==='replay')o.messages.push({role:'assistant',content:[{type:'tool-call',id:'earlier',name:tool.name,arguments:'{"label":"completed"}'}]},{role:'tool',source:{kind:'tool',callId:'earlier'},content:[{type:'text',text:'completed'}]})
  f.web.answer=(p,_,n)=>n===1?'damaged envelope':{...wrap(p,false),...(n===3&&mode==='narration'?{text:'Claimed success without tool results'}:{}),calls:[{name:tool.name,arguments:{label:n===3&&mode==='mutate-valid'?'changed':'completed'}},{name:tool.name,arguments:{label:n===2?false:'pending'}}]}
  try{
   if(mode==='valid'){await collect(a.stream(o));assert.equal(f.web.generations.length,3)}
   else{await assert.rejects(async()=>{for await(const c of a.stream(o))chunks.push(c)});assert.equal(chunks.some(c=>c.blockType==='tool-call'),false);assert.equal(f.web.generations.length,mode==='replay'?2:3)}
  }finally{await a.dispose();await f.close()}
 }
})

test('final targeted correction keeps cancellation, rejected preparation and rate cooldown boundaries',async()=>{
 for(const mode of ['cancel','reject','rate']){
  const f=await setup(),a=adapter(f),o=options(),controller=new AbortController();o.signal=controller.signal;f.native.begin(o.sessionId)
  let preparations=0,limited=0;const original=f.web.fetch
  f.web.answer=(p,_,n)=>n===1?'damaged envelope':wrap(p,n===2?false:'existing')
  f.web.fetch=async(url,opts)=>{
   if(url.endsWith('/create_pow_challenge')&&++preparations===3){if(mode==='cancel'){controller.abort();throw new DOMException('cancelled','AbortError')}if(mode==='reject')return new Response('',{status:401})}
   if(mode==='rate'&&preparations>=3&&url.endsWith('/chat/completion')&&!limited++){return new Response('',{status:429})}
   return original(url,opts)
  }
  try{
   if(mode==='rate'){const chunks=await collect(a.stream(o));assert.equal(chunks.filter(c=>c.block?.type==='tool-call').length,1);assert.equal(f.web.generations.length,3)}
   else{
    await assert.rejects(()=>collect(a.stream(o)));assert.equal(f.web.generations.length,2)
    const op=await f.store.pending((await a.engine()).key(o.sessionId));assert.equal(op.repair.attempt,2);assert.equal(op.identity.responseId,4);assert.equal(op.finalStatus,'FINISHED')
   }
  }finally{await a.dispose();await f.close()}
 }
})

test('progress journals reject invalid attempt states and keep legacy single-attempt records readable',async()=>{
 const {readFile,writeFile}=await import('node:fs/promises')
 const f=await setup(),a=adapter(f),o=options();f.native.begin(o.sessionId)
 f.web.answer=(p,_,n)=>n===1?'damaged envelope':wrap(p,n===2?false:'existing')
 try{
  await collect(a.stream(o));const file=`${f.home}/sessions/${(await a.engine()).key(o.sessionId)}.json`,original=JSON.parse(await readFile(file,'utf8'))
  for(const change of [{attempt:0},{attempt:3},{attempt:2,mode:'protocol'}]){const value=structuredClone(original);Object.assign(value.active.repair,change);await writeFile(file,JSON.stringify(value));await assert.rejects(()=>f.store.pending(value.active.sessionKey),e=>e.code==='STATE_STORAGE')}
  delete original.active.repair.attempt;await writeFile(file,JSON.stringify(original));assert(await f.store.pending(original.active.sessionKey))
  // A cold prepared refinement restores its most recent verified parent, never generates again.
  original.active.repair.attempt=2;await writeFile(file,JSON.stringify(original))
  const key=original.active.sessionKey,op=await f.store.pending(key)
  await f.store.update(key,op.id,{stage:'prepared',identity:undefined,verifiedPath:undefined,finalStatus:undefined});f.native.cancel(op.native)
  const {SessionEngine}=await import('../lib/core/session.js'),{LocalStore}=await import('../lib/local/store.js')
  const cold=new SessionEngine({store:new LocalStore(f.home),storeId:op.storeId,native:f.native,maxPromptChars:120000})
  assert.equal(await cold.verifyPending(f.accountKey,f.web.client(),AbortSignal.timeout(5000),o.sessionId,op.id),true)
  assert.equal((await f.store.session(key)).parentId,4);assert.equal(f.web.generations.length,3)
 }finally{await a.dispose();await f.close()}
})
