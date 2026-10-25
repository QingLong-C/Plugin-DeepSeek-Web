import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {TokenFreeAdapter,PROVIDER,MODEL} from '../lib/dsh/adapter.js'
import {setup,collect,tool,frame,snapshot,sse} from './helpers/fixture.mjs'
import {LocalDiagnostics} from '../lib/local/diagnostics.js'
import {TokenFreeError} from '../lib/core/errors.js'
const constrained={...tool,parameters:{type:'object',properties:{count:{type:'integer',minimum:2},label:{type:'string',minLength:3}},required:['count','label'],additionalProperties:false}}
const opts=()=>({provider:PROVIDER,model:MODEL,messages:[{role:'user',content:[{type:'text',text:'Synthetic bounded argument correction'}]}],tools:[constrained]})
const adapterFor=(f,extra={})=>new TokenFreeAdapter({}, {store:f.store,diagnostics:f.log,credential:async()=>({token:'fixture-secret-token',accountId:'fixture-owner'}),client:(_,c)=>f.web.client(f.log,c.operationId),...extra})
const answer=(p,calls)=>({protocol_version:1,request_id:p.request_id,kind:'tool',calls})
const calls=()=>[{name:tool.name,arguments:{count:2,label:'keep'}},{name:tool.name,arguments:{count:1,label:'fix'}}]

test('one automatic correction delivers only the corrected whole batch with bounded rule feedback',async()=>{
 const f=await setup(home=>new LocalDiagnostics(home,false)),a=adapterFor(f)
 f.web.answer=(p,_,n)=>answer(p,n===1?calls():[{...calls()[0]},{name:tool.name,arguments:{count:2,label:'fix'}}])
 try{
  const chunks=await collect(a.stream(opts())),delivered=chunks.filter(c=>c.type==='block-end'&&c.block.type==='tool-call')
  assert.equal(delivered.length,2);assert.deepEqual(JSON.parse(delivered[0].block.arguments),calls()[0].arguments)
  assert.equal(JSON.parse(delivered[1].block.arguments).count,2)
  assert.equal(f.web.generations.length,2);assert.equal(f.web.chats.size,1);assert.equal(f.web.generations[1].parent_message_id,2)
  const feedback=JSON.parse(f.web.generations[1].prompt.split('TOOL_ARGUMENT_CORRECTION_JSON:\n')[1])
  assert.equal(feedback.attempt,1);assert.deepEqual(feedback.errors.map(e=>[e.call,e.name,e.path,e.rule]),[[1,tool.name,'/count','minimum']])
  assert.equal(feedback.response_contract.enforcement,'local-validation')
  assert.deepEqual(feedback.tools,[constrained]);assert.deepEqual(feedback.calls,[{name:tool.name},{name:tool.name}])
  await f.log.flush();const rows=(await readFile(f.log.file,'utf8')).trim().split('\n').map(JSON.parse)
  const event=rows.filter(r=>r.event==='model.format-repair'&&r.stage==='tool-arguments');assert.equal(event.length,1)
  assert.equal(JSON.stringify(event).includes('keep'),false)
 }finally{await a.dispose();await f.close()}
})

test('invalid second response stops after one correction and delivers zero partial calls',async()=>{
 const f=await setup(),a=adapterFor(f),chunks=[];f.web.answer=p=>answer(p,calls())
 try{
  await assert.rejects(async()=>{for await(const c of a.stream(opts()))chunks.push(c)},e=>e.code==='INVALID_TOOL_CALL'&&e.message.includes('已自动纠正一次'))
  assert.equal(f.web.generations.length,2);assert.equal(chunks.some(c=>c.blockType==='tool-call'||c.block?.type==='tool-call'),false)
 }finally{await a.dispose();await f.close()}
})

test('correction cannot change a valid call, tool names, order/count, or turn the action into streamed final text',async()=>{
 for(const corrected of [
  [{name:tool.name,arguments:{count:3,label:'keep'}},{name:tool.name,arguments:{count:2,label:'fix'}}],
  [{name:'other',arguments:{count:2,label:'keep'}},{name:tool.name,arguments:{count:2,label:'fix'}}],
  [{name:tool.name,arguments:{count:2,label:'fix'}},{name:tool.name,arguments:{count:2,label:'keep'}}],
  [{name:tool.name,arguments:{count:2,label:'keep'}}],null]){
  const f=await setup(),a=adapterFor(f),chunks=[]
  f.web.answer=(p,_,n)=>n===1?answer(p,calls()):corrected?answer(p,corrected):{protocol_version:1,request_id:p.request_id,kind:'final',text:'unexecuted claim'}
  try{
   await assert.rejects(async()=>{for await(const c of a.stream({...opts(),tools:[constrained,{...constrained,name:'other'}]}))chunks.push(c)},e=>e.code==='WEB_TOOL_FORMAT')
   assert.equal(f.web.generations.length,2);assert.equal(chunks.some(c=>c.blockType==='tool-call'||c.type==='text-delta'),false)
  }finally{await a.dispose();await f.close()}
 }
})

test('missing metadata neither spends nor bypasses the single argument correction budget',async()=>{
 for(const missingFirst of [true,false]){
  const f=await setup(),a=adapterFor(f)
  f.web.answer=(p,_,n)=>n===1?(missingFirst?{kind:'tool',calls:[calls()[1]]}:answer(p,[calls()[1]]))
   :missingFirst?answer(p,[calls()[0]]):{kind:'tool',calls:[calls()[0]]}
  try{const chunks=await collect(a.stream(opts()));assert.equal(f.web.generations.length,2);assert.deepEqual(chunks.filter(c=>c.block?.type==='tool-call').map(c=>JSON.parse(c.block.arguments)),[calls()[0].arguments])}finally{await a.dispose();await f.close()}
 }
 const f=await setup(),a=adapterFor(f)
 f.web.answer=()=>({kind:'tool',calls:[calls()[1]]})
 try{await assert.rejects(()=>collect(a.stream(opts())),e=>e.code==='INVALID_TOOL_CALL');assert.equal(f.web.generations.length,2)}finally{await a.dispose();await f.close()}
})

test('missing fields, wrong types and schema violations get one model correction without local coercion',async()=>{
 for(const args of [{count:2},{count:'2',label:'valid'},{count:2,label:'x'},{count:2,label:'valid',extra:true}]){
  const f=await setup(),a=adapterFor(f);f.web.answer=(p,_,n)=>answer(p,[{name:tool.name,arguments:n===1?args:{count:2,label:'valid'}}])
  try{const chunks=await collect(a.stream(opts()));assert.equal(f.web.generations.length,2);assert.deepEqual(JSON.parse(chunks.find(c=>c.block?.type==='tool-call').block.arguments),{count:2,label:'valid'})}finally{await a.dispose();await f.close()}
 }
})


test('native one-shot policy is consumed only by one corrected durable assistant commit',async()=>{
 const f=await setup(),a=adapterFor(f,{native:f.native}),id='native-correction'
 f.web.answer=(p,_,n)=>answer(p,[{name:tool.name,arguments:n===1?{count:1,label:'valid'}:{count:2,label:'valid'}}])
 try{
  await a.setPolicy(id,{tools:{mode:'required'},output:{type:'text'}});f.native.begin(id)
  const chunks=await collect(a.stream({...opts(),sessionId:id}))
  const op=await f.store.pending((await a.engine()).key(id));assert.equal(op.repair.mode,'arguments')
  assert.equal(op.expected.filter(b=>b.type==='tool-call').length,1);assert.equal((await a.policy(id)).tools.mode,'required')
  f.native.save({operation:op,blocks:chunks.filter(c=>c.type==='block-end').map(c=>c.block)})
  await a.reconcile(id);assert.equal(await f.store.pending((await a.engine()).key(id)),undefined)
  assert.equal((await a.policy(id)).tools.mode,'auto');assert.equal(f.web.generations.length,2)
 }finally{await a.dispose();await f.close()}
})

test('correction preparation rejection or cancellation retains the original verified response and never repeats execution',async()=>{
 for(const cancelled of [false,true]){
  const f=await setup(),a=adapterFor(f,{native:f.native}),id='failed-correction',controller=new AbortController()
  const original=f.web.fetch;let challenges=0
  f.web.answer=p=>answer(p,[calls()[1]])
  f.web.fetch=async(url,options)=>{
   if(url.endsWith('/create_pow_challenge')&&++challenges===2){
    if(cancelled){controller.abort();throw new DOMException('cancelled','AbortError')}
    return new Response('',{status:401})
   }
   return original(url,options)
  }
  try{
   await a.setPolicy(id,{tools:{mode:'required'},output:{type:'text'}});f.native.begin(id)
   await assert.rejects(()=>collect(a.stream({...opts(),sessionId:id,signal:controller.signal})))
   const pending=await f.store.pending((await a.engine()).key(id));assert.equal(pending.identity.responseId,2);assert.equal(pending.finalStatus,'FINISHED')
   assert.equal(f.web.generations.length,1);assert.equal((await a.policy(id)).tools.mode,'required')
   f.native.cancel(pending.native);await a.reconcile(id)
   assert.equal((await a.inspect(id)).needsRebase,true)
  }finally{await a.dispose();await f.close()}
 }
})

test('a disconnect during correction resumes the same corrected response without a third generation',async()=>{
 const f=await setup(),a=adapterFor(f)
 f.web.answer=(p,_,n)=>answer(p,[{name:tool.name,arguments:n===1?calls()[1].arguments:{count:2,label:'valid'}}])
 f.web.completion=({ready,text})=>sse(ready+frame(snapshot(f.web.generations.length===2?text.slice(0,-3):text,f.web.generations.length===2?'WIP':'FINISHED')))
 try{const chunks=await collect(a.stream(opts()));assert.equal(f.web.generations.length,2);assert.equal(f.web.resumes.length,1);assert.equal(chunks.filter(c=>c.block?.type==='tool-call').length,1)}finally{await a.dispose();await f.close()}
})

test('changed native tool bindings still deny a corrected batch before any delivery',async()=>{
 const f=await setup(),a=adapterFor(f,{native:f.native,toolCatalogue:(_,tools)=>tools,checkTools:()=>{if(f.web.generations.length===2)throw new TokenFreeError('native binding changed','TOOL_CHANGED')}}),chunks=[],id='changed-correction'
 f.web.answer=(p,_,n)=>answer(p,[{name:tool.name,arguments:n===1?calls()[1].arguments:{count:2,label:'valid'}}])
 try{
  f.native.begin(id);await assert.rejects(async()=>{for await(const c of a.stream({...opts(),sessionId:id}))chunks.push(c)},e=>e.code==='TOOL_CHANGED')
  assert.equal(f.web.generations.length,2);assert.equal(chunks.some(c=>c.blockType==='tool-call'),false)
 }finally{await a.dispose();await f.close()}
})
