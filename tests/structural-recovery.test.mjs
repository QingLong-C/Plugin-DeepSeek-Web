import {test} from 'node:test'
import assert from 'node:assert/strict'
import {decodeResponse} from '../lib/core/codec.js'
import {TokenFreeAdapter,PROVIDER,MODEL} from '../lib/dsh/adapter.js'
import {setup,collect} from './helpers/fixture.mjs'

const tool={name:'inspect',description:'Read the existing artifact',parameters:{type:'object',additionalProperties:false,properties:{command:{type:'string'},run_in_background:{type:'boolean'},count:{type:'integer'},nested:{type:'object'}},required:['command']}}
const args={command:'literal \\n " <>() {} 中文',run_in_background:true,count:0,nested:{flag:false,value:null}}
const envelope=(calls,id='op')=>({protocol_version:1,request_id:id,kind:'tool',calls})
const good=id=>envelope([{name:tool.name,arguments:args}],id)

test('bounded envelope framing composes with punctuation recovery and preserves scalar bytes',()=>{
 const raw=JSON.stringify(good())
 for(const prefix of ['<','(','<>','((<'])for(const suffix of ['', '>','))','>)']){
  let recovered=0
  const blocks=decodeResponse(prefix+raw+suffix,[tool],'op',undefined,()=>recovered++)
  assert.deepEqual(JSON.parse(blocks[0].arguments),args);assert.equal(recovered,1)
 }
 assert.deepEqual(JSON.parse(decodeResponse('<'+raw.slice(0,-1)+',}}>',[tool],'op')[0].arguments),args)
 for(const raw of ['<'.repeat(9)+JSON.stringify(good()),'<example>'+JSON.stringify(good()),'note '+JSON.stringify(good()),JSON.stringify(good())+';','<'+JSON.stringify(good())+JSON.stringify(good()),'<{"kind":"tool","kind":"tool"}>'])assert.throws(()=>decodeResponse(raw,[tool],'op'))
 assert.equal(decodeResponse('<'+JSON.stringify(good('other')),[tool],'op')[0].id,'tokenfree_op_0')
})

test('schema-declared fields at call level move losslessly into the single arguments object',()=>{
 const keys=Object.keys(args)
 for(let mask=1;mask<1<<keys.length;mask++){
  const call={name:tool.name,arguments:{}}
  for(const [i,key]of keys.entries())(mask>>i&1?call:call.arguments)[key]=args[key]
  for(const encoded of [false,true]){
   const value=structuredClone(call);if(encoded)value.arguments=JSON.stringify(value.arguments)
   assert.deepEqual(JSON.parse(decodeResponse('<'+JSON.stringify(envelope([value]))+'>',[tool],'op')[0].arguments),args)
  }
 }
 assert.deepEqual(JSON.parse(decodeResponse(JSON.stringify(envelope([{name:tool.name,...args}])),[tool],'op')[0].arguments),args)
 // Missing empty arguments are not invented for an arbitrary name-only call.
 for(const call of [{name:tool.name},{name:tool.name,arguments:{command:'a'},command:'a'},{name:tool.name,arguments:{},unknown:true},{name:tool.name,arguments:null,command:'a'}])assert.throws(()=>decodeResponse(JSON.stringify(envelope([call])),[tool],'op'))
 assert.throws(()=>decodeResponse(JSON.stringify(envelope([{name:'missing',...args}])),[tool],'op'))
})

test('structural recovery never suppresses complete original-schema validation or partial batch rejection',()=>{
 let checked=0
 const raw=JSON.stringify(envelope([{name:tool.name,arguments:{command:'ok'},run_in_background:'wrong'}]))
 assert.throws(()=>decodeResponse(raw,[tool],'op',(_,a)=>{checked++;assert.equal(typeof a.run_in_background,'boolean')}))
 assert.equal(checked,1)
 assert.throws(()=>decodeResponse(JSON.stringify(envelope([{name:tool.name,...args},{name:tool.name,arguments:{},unknown:true}])),[tool],'op'))
 // Permissive additionalProperties is not a declaration or a license to move unknown fields.
 assert.throws(()=>decodeResponse(raw,[{name:tool.name,parameters:{type:'object'}}],'op'))
})

test('every candidate gets local recovery, including a malformed correction after the shared budget is spent',async()=>{
 for(const mode of ['initial','second','schema']){
  const f=await setup(),a=new TokenFreeAdapter({}, {store:f.store,native:f.native,credential:async()=>({token:'fixture',accountId:'fixture-owner'}),client:(_,c)=>f.web.client(f.log,c.operationId)})
  const options={provider:PROVIDER,model:MODEL,messages:[{role:'user',content:[{type:'text',text:'Inspect only the existing artifact; do not repeat earlier work.'}]}],tools:[tool]}
  f.web.answer=(p,_,n)=>n===1&&mode!=='initial'?mode==='second'?'unrecognised broken response':envelope([{name:tool.name,arguments:{command:'ok'},run_in_background:'wrong'}],p.request_id):'<'+JSON.stringify(envelope([{name:tool.name,arguments:{command:'ok'},run_in_background:true}],p.request_id))
  try{
   const chunks=await collect(a.stream(options)),calls=chunks.filter(c=>c.block?.type==='tool-call')
   assert.equal(calls.length,1);assert.deepEqual(JSON.parse(calls[0].block.arguments),{command:'ok',run_in_background:true})
   assert.equal(f.web.generations.length,mode==='initial'?1:2)
  }finally{await a.dispose();await f.close()}
 }
})

test('generated schema fields, partitions and combined damage preserve values across different tools',t=>{
 let cases=0
 for(let seed=1;seed<=64;seed++){
  const values=Object.fromEntries(Array.from({length:4},(_,i)=>[`field_${seed}_${i}`,[`literal \\n " <>() ${seed}`,false,0,{items:[null,true,'}']}][i]]))
  const declared={name:`inspect_${seed}`,parameters:{type:'object',properties:Object.fromEntries(Object.keys(values).map(k=>[k,{}]))}}
  for(let mask=1;mask<16;mask++)for(const style of ['plain','framing','encoded','comma']){
   const call={name:declared.name,arguments:{}}
   for(const [i,key]of Object.keys(values).entries())(mask>>i&1?call:call.arguments)[key]=values[key]
   if(style==='encoded')call.arguments=JSON.stringify(call.arguments)
   let raw=JSON.stringify(envelope([call]));if(style==='framing')raw='<('+raw+')>';if(style==='comma')raw=raw.slice(0,-1)+',}}'
   assert.deepEqual(JSON.parse(decodeResponse(raw,[declared],'op')[0].arguments),values);cases++
  }
 }
 assert.equal(cases,3840);t.diagnostic(`${cases} lossless composition cases across 64 independently declared tool schemas`)
})
