import {test} from 'node:test'
import assert from 'node:assert/strict'
import {decodeResponse} from '../lib/core/codec.js'
import {SessionEngine} from '../lib/core/session.js'
import {setup,collect,input} from './helpers/fixture.mjs'
const tool={name:'inspect',description:'Inspect an existing file',parameters:{type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false}}
const id='current-operation'
const body={kind:'tool',calls:[{name:'inspect',arguments:{path:'existing'}}]}
const wrapped={protocol_version:1,request_id:id,...body}
const arg=(name,value,string=false)=>`<｜｜DSML｜｜ parameter name="${name}" string="${string}">${string?value:JSON.stringify(value)}</｜｜DSML｜｜ parameter>`
const dsml=params=>`<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="inspect">${params}</｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>`

test('a rejected correction kind reaches relay with original tool intent and full contract',async()=>{
 const f=await setup();let relayCalls=0;const i=input(undefined,'adoption-kind',[tool]);f.native.begin(i.sessionId)
 const engine=new SessionEngine({store:f.store,native:f.native,storeId:'fixture-store',maxPromptChars:120000,repairRelay:async r=>{
  relayCalls++;const p=JSON.parse(r.prompt.split('DSH_INPUT_JSON:\n')[1].split('\n\nDSH_RESPONSE_CONTRACT:')[0]);
  assert(r.prompt.includes('existing file'));assert(r.prompt.includes('"required":["path"]'))
  assert.throws(()=>r.validate(JSON.stringify({protocol_version:1,request_id:p.request_id,kind:'final',text:'unexecuted result'})),e=>e.code==='WEB_TOOL_FORMAT')
  const text=JSON.stringify({...body,protocol_version:1,request_id:p.request_id});r.validate(text);return {text,provider:'fixture',model:'repair'}
 }})
 f.web.answer=(p,_,n)=>n===1?dsml(arg('unrecognized','bad',true))+ '<broken>':{protocol_version:1,request_id:p.request_id,kind:'final',text:'unexecuted result'}
 try{const events=await collect(engine.run(i,f.accountKey,f.web.client(),AbortSignal.timeout(5000),(raw,op)=>decodeResponse(raw,i.tools,op)));assert.equal(relayCalls,1);assert.equal(f.web.generations.length,2);assert.equal(events.find(e=>e.type==='result').blocks.filter(b=>b.type==='tool-call').length,1)}finally{await f.close()}
})

test('complete encoded envelope and inferred intent preserve arguments; routing metadata is optional',()=>{
 for(const value of [body,{...body,protocol_version:1},{...body,request_id:id},{calls:body.calls},wrapped]){
  for(const raw of [JSON.stringify(value),JSON.stringify(JSON.stringify(value))]){
   const recovered=[];const blocks=decodeResponse(raw,[tool],id,undefined,k=>recovered.push(k));assert.equal(blocks.length,1);assert.equal(blocks[0].name,'inspect');assert.deepEqual(JSON.parse(blocks[0].arguments),{path:'existing'});
   assert.equal(recovered.length>0,raw!==JSON.stringify(value)||value.kind===undefined)
  }
 }
})

test('DSML redundant matching tool metadata keeps its complete arguments and repairs punctuation',()=>{
 const params=arg('arguments',{path:'existing'}).replace('}</','}}</')+arg('name','inspect',true)
 assert.deepEqual(JSON.parse(decodeResponse(dsml(params),[tool],id)[0].arguments),{path:'existing'})
 for(const params of [arg('arguments',{path:'existing'})+arg('name','other',true),arg('arguments',{path:'existing'})+arg('extra','inspect',true)])assert.throws(()=>decodeResponse(dsml(params),[tool],id))
 const declared={...tool,parameters:{type:'object',properties:{name:{type:'string'},path:{type:'string'}}}}
 assert.throws(()=>decodeResponse(dsml(arg('arguments',{path:'existing'})+arg('name','inspect',true)),[declared],id))
})

test('local recovery never extracts commands from prose or resolves contradictory intent; metadata has no authority',()=>{
 const raw=JSON.stringify(wrapped)
 for(const s of ['Do not execute: '+raw,raw+' do not execute',raw+raw,JSON.stringify(JSON.stringify(raw)),JSON.stringify({calls:body.calls,text:'both kinds'}),JSON.stringify({...body,calls:[]}),'{"kind":"final","text":"a","text":"b"}'])assert.throws(()=>decodeResponse(s,[tool],id))
 for(const v of [{...body,request_id:'other'},{...wrapped,request_id:'other'}])assert.equal(decodeResponse(JSON.stringify(v),[tool],id)[0].id,`tokenfree_${id}_0`)
 assert.throws(()=>decodeResponse(JSON.stringify({...body,protocol_version:2}),[tool],id),e=>e.code==='WEB_TOOL_FORMAT')
})

test('relay receives the original frozen batch after a correction changes a valid call',async()=>{
 const {StrictSchemas}=await import('../lib/dsh/strict-schema.js')
 const schemas=new StrictSchemas(),f=await setup(),i=input(undefined,'frozen-relay',[tool]);f.native.begin(i.sessionId)
 const original=[{name:'inspect',arguments:{path:'keep'}},{name:'inspect',arguments:{path:4}}]
 const changed=[{name:'inspect',arguments:{path:'WRONG'}},{name:'inspect',arguments:{path:'fixed'}}]
 let relays=0
 const engine=new SessionEngine({store:f.store,native:f.native,storeId:'fixture-store',maxPromptChars:120000,repairRelay:async r=>{
  relays++;const p=JSON.parse(r.prompt.split('DSH_INPUT_JSON:\n')[1].split('\n\nDSH_RESPONSE_CONTRACT:')[0])
  const correction=JSON.parse(r.prompt.split('DSH_PROTOCOL_CORRECTION_JSON:\n')[1])
  assert.deepEqual(correction.batch_constraints.calls,original)
  assert.deepEqual(correction.batch_constraints.invalid_calls,[1])
  assert.throws(()=>r.validate(JSON.stringify({protocol_version:1,request_id:p.request_id,kind:'tool',calls:changed})),e=>e.code==='WEB_TOOL_FORMAT')
  const text=JSON.stringify({protocol_version:1,request_id:p.request_id,kind:'tool',calls:[original[0],changed[1]]});r.validate(text);return{text,provider:'fixture',model:'repair'}
 }})
 f.web.answer=(p,_,n)=>({protocol_version:1,request_id:p.request_id,kind:'tool',calls:n===1?original:changed})
 try{const events=await collect(engine.run(i,f.accountKey,f.web.client(),AbortSignal.timeout(5000),(raw,op)=>decodeResponse(raw,i.tools,op,(t,v)=>schemas.check(t.parameters,v))));assert.equal(relays,1);assert.equal(f.web.generations.length,2);assert.deepEqual(events.find(e=>e.type==='result').blocks.map(b=>JSON.parse(b.arguments)),[{path:'keep'},{path:'fixed'}])}finally{await f.close()}
})

test('relay cannot turn a failed final answer into a tool call',async()=>{
 const f=await setup(),i=input(undefined,'final-relay',[tool]);f.native.begin(i.sessionId);let relays=0
 const engine=new SessionEngine({store:f.store,native:f.native,storeId:'fixture-store',maxPromptChars:120000,repairRelay:async r=>{
  relays++;const p=JSON.parse(r.prompt.split('DSH_INPUT_JSON:\n')[1].split('\n\nDSH_RESPONSE_CONTRACT:')[0])
  assert.throws(()=>r.validate(JSON.stringify({...body,protocol_version:1,request_id:p.request_id})),e=>e.code==='WEB_TOOL_FORMAT')
  const text=JSON.stringify({protocol_version:1,request_id:p.request_id,kind:'final',text:'Existing result summarized'});r.validate(text);return{text,provider:'fixture',model:'repair'}
 }})
 f.web.answer=(p,_,n)=>({protocol_version:1,request_id:p.request_id,...(n===1?{kind:'final',text:42}:body)})
 try{const events=await collect(engine.run(i,f.accountKey,f.web.client(),AbortSignal.timeout(5000),(raw,op)=>decodeResponse(raw,i.tools,op)));assert.equal(relays,1);assert.equal(f.web.generations.length,2);assert.deepEqual(events.find(e=>e.type==='result').blocks,[{type:'text',text:'Existing result summarized'}])}finally{await f.close()}
})

test('relay batch constraints are mandatory within input limits, while rejected text is optional',async()=>{
 const {encodeProtocolCorrection}=await import('../lib/core/codec.js'),i=input(undefined,'bounded',[tool])
 const constraints={calls:body.calls,invalid_calls:[0]}
 const full=encodeProtocolCorrection(i,id,120000,'tool',undefined,'rejected',constraints)
 const limit=full.length-2
 const reduced=encodeProtocolCorrection(i,id,limit,'tool',undefined,'rejected',constraints)
 assert(reduced.length<=limit);assert.deepEqual(JSON.parse(reduced.split('DSH_PROTOCOL_CORRECTION_JSON:\n')[1]).batch_constraints,constraints)
 assert.throws(()=>encodeProtocolCorrection(i,id,limit,'tool',undefined,undefined,{calls:[{name:'inspect',arguments:{path:'x'.repeat(limit)}}],invalid_calls:[0]}),e=>e.code==='INPUT_TOO_LARGE')
})
