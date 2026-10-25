import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {TokenFreeAdapter,PROVIDER,MODEL} from '../lib/dsh/adapter.js'
import {setup,collect,tool,frame,snapshot,sse} from './helpers/fixture.mjs'
import {LocalDiagnostics} from '../lib/local/diagnostics.js'
import {TokenFreeError} from '../lib/core/errors.js'
import {encodeInput,modelInput} from '../lib/core/codec.js'
const broken='<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="read_marker"><｜｜DSML｜｜ parameter name="arguments":{}\nImagined tool result: SYNTHETIC_RESULT\n<｜｜DSML｜｜ calls>'
const opts=()=>({provider:PROVIDER,model:MODEL,messages:[{role:'user',content:[{type:'text',text:'Inspect the already completed artifact; do not repeat earlier work.'}]}],tools:[tool]})
const adapterFor=(f,extra={})=>new TokenFreeAdapter({}, {store:f.store,diagnostics:f.log,credential:async()=>({token:'fixture-secret-token',accountId:'fixture-owner'}),client:(_,c)=>f.web.client(f.log,c.operationId),...extra})
const answer=p=>({protocol_version:1,request_id:p.request_id,kind:'tool',calls:[{name:tool.name,arguments:{}}]})

test('broken whole tool protocol regenerates once from authoritative DSH context without importing invented results',async()=>{
 const f=await setup(home=>new LocalDiagnostics(home,false)),a=adapterFor(f)
 f.web.answer=(p,_,n)=>n===1?broken:answer(p)
 try{
  const chunks=await collect(a.stream(opts()))
  assert.equal(chunks.filter(c=>c.block?.type==='tool-call').length,1)
  assert.equal(f.web.generations.length,2);assert.equal(f.web.chats.size,1)
  assert.equal(f.web.generations[1].parent_message_id,2)
  const prompt=f.web.generations[1].prompt
  assert(prompt.includes('DSH_PROTOCOL_CORRECTION_JSON:'));assert(prompt.includes(opts().messages[0].content[0].text))
  assert.equal(prompt.includes('SYNTHETIC_RESULT'),false)
  const context=JSON.parse(prompt.split('DSH_INPUT_JSON:\n')[1].split('\n\nDSH_RESPONSE_CONTRACT:\n')[0])
  assert.deepEqual(context.messages,opts().messages);assert.deepEqual(context.tools,[tool])
  await f.log.flush();const rows=(await readFile(f.log.file,'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(rows.filter(r=>r.event==='model.format-repair'&&r.stage==='tool-protocol'&&r.attempt===1).length,1)
 }finally{await a.dispose();await f.close()}
})

test('protocol retry shares one budget with wrapper and argument repair and never delivers an invalid second response',async()=>{
 for(const second of [broken,p=>({kind:'tool',calls:answer(p).calls}),p=>({...answer(p),calls:[{name:tool.name,arguments:{extra:true}}]})]){
  const f=await setup(),a=adapterFor(f),chunks=[]
  f.web.answer=(p,_,n)=>n===1?broken:typeof second==='function'?second(p):second
  try{await assert.rejects(async()=>{for await(const c of a.stream(opts()))chunks.push(c)})
   assert.equal(f.web.generations.length,2);assert.equal(chunks.some(c=>c.blockType==='tool-call'||c.type==='text'),false)
  }finally{await a.dispose();await f.close()}
 }
})

test('protocol correction rejects success narratives, unknown tools and repetitions of already delivered calls',async()=>{
 for(const mode of ['narrative','unknown','repeat']){
  const f=await setup(),a=adapterFor(f),options=opts(),chunks=[]
  if(mode==='repeat') options.messages.push({role:'assistant',content:[{type:'tool-call',id:'delivered',name:tool.name,arguments:'{}'}]},
   {role:'tool',source:{kind:'tool',callId:'delivered'},content:[{type:'text',text:'completed'}]})
  f.web.answer=(p,_,n)=>n===1?broken:mode==='narrative'?{protocol_version:1,request_id:p.request_id,kind:'final',text:'unexecuted success'}:mode==='unknown'?{...answer(p),calls:[{name:'unavailable',arguments:{}}]}:answer(p)
  try{await assert.rejects(async()=>{for await(const c of a.stream(options))chunks.push(c)},e=>e.code==='WEB_TOOL_FORMAT')
   assert.equal(f.web.generations.length,2);assert.equal(chunks.some(c=>c.blockType==='tool-call'||c.type==='text'),false)
  }finally{await a.dispose();await f.close()}
 }
})

test('protocol correction keeps original rejection evidence on cancellation or preparation failure and commits only corrected native output',async()=>{
 for(const mode of ['cancel','reject','commit']){
  const f=await setup(),a=adapterFor(f,{native:f.native}),id=`protocol-${mode}`,controller=new AbortController()
  f.web.answer=(p,_,n)=>n===1?broken:answer(p)
  const original=f.web.fetch;let challenges=0
  f.web.fetch=async(url,options)=>{
   if(url.endsWith('/create_pow_challenge')&&++challenges===2&&mode!=='commit'){
    if(mode==='cancel'){controller.abort();throw new DOMException('cancelled','AbortError')}
    return new Response('',{status:401})
   }return original(url,options)
  }
  try{
   f.native.begin(id);await a.setPolicy(id,{tools:{mode:'required'},output:{type:'text'}})
   if(mode==='commit'){
    const chunks=await collect(a.stream({...opts(),sessionId:id}))
    const op=await f.store.pending((await a.engine()).key(id));assert.equal(op.repair.mode,'protocol')
    f.native.save({operation:op,blocks:chunks.filter(c=>c.type==='block-end').map(c=>c.block)})
    await a.reconcile(id);assert.equal(await f.store.pending((await a.engine()).key(id)),undefined)
    assert.equal((await a.policy(id)).tools.mode,'auto')
   }else{
    await assert.rejects(()=>collect(a.stream({...opts(),sessionId:id,signal:controller.signal})))
    const op=await f.store.pending((await a.engine()).key(id));assert.equal(op.identity.responseId,2);assert.equal(op.finalStatus,'FINISHED')
    assert.equal(f.web.generations.length,1);assert.equal((await a.policy(id)).tools.mode,'required')
   }
  }finally{await a.dispose();await f.close()}
 }
})

test('protocol correction resumes its existing response and preserves native binding guards',async()=>{
 for(const changed of [false,true]){
  const f=await setup(),a=adapterFor(f,{native:f.native,toolCatalogue:(_,tools)=>tools,checkTools:()=>{if(changed&&f.web.generations.length===2)throw new TokenFreeError('changed','TOOL_CHANGED')}}),chunks=[],id='protocol-binding'
  f.web.answer=(p,_,n)=>n===1?broken:answer(p)
  f.web.completion=({ready,text})=>sse(ready+frame(snapshot(f.web.generations.length===2?text.slice(0,-3):text,f.web.generations.length===2?'WIP':'FINISHED')))
  try{
   f.native.begin(id)
   if(changed)await assert.rejects(async()=>{for await(const c of a.stream({...opts(),sessionId:id}))chunks.push(c)},e=>e.code==='TOOL_CHANGED')
   else chunks.push(...await collect(a.stream({...opts(),sessionId:id})))
   assert.equal(f.web.generations.length,2);assert.equal(f.web.resumes.length,1)
   assert.equal(chunks.filter(c=>c.block?.type==='tool-call').length,changed?0:1)
  }finally{await a.dispose();await f.close()}
 }
})

test('identity mismatch, complete unknown tools and content filtering do not become protocol regeneration',async()=>{
 for(const mode of ['identity','unknown','filter']){
  const f=await setup(),a=adapterFor(f)
  f.web.answer=p=>mode==='identity'?{...answer(p),request_id:'other'}:mode==='unknown'?{...answer(p),calls:[{name:'unknown',arguments:{}}]}:broken
  if(mode==='filter')f.web.completion=({ready,text})=>sse(ready+frame(snapshot(text,'CONTENT_FILTER')))
  try{await assert.rejects(()=>collect(a.stream(opts())));assert.equal(f.web.generations.length,1)}finally{await a.dispose();await f.close()}
 }
})

test('broken JSON tool containers and mixed DSML transcripts regenerate without weakening their parser',async()=>{
 for(const first of ['{"kind":"tool","calls":[BROKEN',broken+'\nmore trailing narration']){
  const f=await setup(),a=adapterFor(f);f.web.answer=(p,_,n)=>n===1?first:answer(p)
  try{const chunks=await collect(a.stream(opts()));assert.equal(f.web.generations.length,2);assert.equal(chunks.filter(c=>c.block?.type==='tool-call').length,1)}finally{await a.dispose();await f.close()}
 }
})

test('oversize protocol correction refuses before a second generation and tools-none policy remains authoritative',async()=>{
 for(const none of [false,true]){
  const f=await setup(),options=opts()
  const maxPromptChars=encodeInput(modelInput(options),'x'.repeat(36),0,[],true,120000).length+10
  const a=new TokenFreeAdapter({maxPromptChars}, {store:f.store,native:f.native,credential:async()=>({token:'fixture',accountId:'fixture-owner'}),client:(_,c)=>f.web.client(f.log,c.operationId)})
  f.web.answer=()=>broken
  try{if(none){options.sessionId='none';f.native.begin('none');await a.setPolicy('none',{tools:{mode:'none'},output:{type:'text'}})}
   await assert.rejects(()=>collect(a.stream(options)));assert.equal(f.web.generations.length,1)
  }finally{await a.dispose();await f.close()}
 }
})

test('an earlier wrapper or argument correction cannot add a later protocol regeneration',async()=>{
 for(const first of [p=>({kind:'tool',calls:answer(p).calls}),p=>({...answer(p),calls:[{name:tool.name,arguments:{extra:true}}]})]){
  const f=await setup(),a=adapterFor(f);f.web.answer=(p,_,n)=>n===1?first(p):broken
  try{await assert.rejects(()=>collect(a.stream(opts())));assert.equal(f.web.generations.length,2)}finally{await a.dispose();await f.close()}
 }
})
