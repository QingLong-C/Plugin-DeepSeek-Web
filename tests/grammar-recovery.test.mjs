import {test} from 'node:test'
import assert from 'node:assert/strict'
import {toolJson,strictJson} from '../lib/core/json.js'
import {decodeResponse} from '../lib/core/codec.js'
import {TokenFreeAdapter,PROVIDER,MODEL} from '../lib/dsh/adapter.js'
import {setup,collect} from './helpers/fixture.mjs'
import {StrictSchemas} from '../lib/dsh/strict-schema.js'

const tool={name:'inspect',description:'Inspect an existing artifact',parameters:{type:'object',additionalProperties:false,required:['command'],properties:{command:{type:'string'}}}}
const command='printf \'%s\\n\' \'literal },{"name": [ : 中文\'\n# actual newline'
const envelope=id=>({protocol_version:1,request_id:id,kind:'tool',calls:[{name:'inspect',arguments:{command}},{name:'inspect',arguments:{command:'inspect only'}}]})
const broken=id=>JSON.stringify(envelope(id)).replace('}},{"name"','},{"name"')

test('grammar recovery reconstructs an internal call boundary without changing either command',()=>{
 let repairs=0
 const blocks=decodeResponse(broken('op'),[tool],'op',undefined,()=>repairs++)
 assert.deepEqual(blocks.map(b=>JSON.parse(b.arguments)),envelope('op').calls.map(c=>c.arguments))
 assert.equal(repairs,1)
})

test('grammar covers nested separators and internal closing containers, not a tool-name pattern',()=>{
 for(const [damaged,expected] of [
  ['{"α":[{"x":1,{"x":2}]}',{α:[{x:1},{x:2}]}],
  ['{"α":[[1],[3]}',{α:[[1],[3]]}],
  ['{"x" 1 "y":false}',{x:1,y:false}],
  ['[1 true null "text"]',[1,true,null,'text']],
  ['{"nested":{"value":1],"end":true}',null],
 ]){
  if(expected===null)assert.throws(()=>toolJson(damaged))
  else assert.deepEqual(JSON.parse(JSON.stringify(toolJson(damaged))),expected,damaged)
 }
})

test('ambiguous structure, duplicate keys, missing values and damaged strings never become calls',()=>{
 for(const raw of [
  '{"a":{"b":1,"c":2}', // c may belong to either object
  '{"a":1,"a":2}', '{"a":}', '[1,,2]', '{"a":1e}',
  '{"a":"unfinished}', '{"a":"bad\\q"}', '{"a":undefined}',
  '{"a":1} {"b":2}', 'prose {"a":1}', '{"a":1;"b":2}',
 ])assert.throws(()=>toolJson(raw),raw)
 assert.throws(()=>decodeResponse(broken('wrong'),[tool],'op'),e=>e.code==='WEB_IDENTITY')
 const bad=broken('op').replace('"inspect only"','false')
 assert.throws(()=>decodeResponse(bad,[tool],'op',(_,a)=>{assert.equal(typeof a.command,'string')}))
})

test('identity errors remain terminal even when syntax has multiple equivalent structural interpretations',async()=>{
 const declared={name:'inspect',description:'Read only',parameters:{type:'object',properties:{description:{type:'string'},command:{type:'string'}}}}
 const raw=id=>JSON.stringify({protocol_version:1,request_id:id,kind:'tool',calls:[{name:'inspect',arguments:{description:'first',command:'read only'}},{name:'inspect',arguments:{command:'second'}}]}).replace('}},{"name"','},{"name"')
 assert.throws(()=>decodeResponse(raw('wrong'),[declared],'op'),e=>e.code==='WEB_IDENTITY')
 const f=await setup(),a=new TokenFreeAdapter({}, {store:f.store,native:f.native,credential:async()=>({token:'fixture',accountId:'fixture-owner'}),client:(_,c)=>f.web.client(f.log,c.operationId)}),chunks=[]
 f.web.answer=()=>raw('wrong')
 try{
  await assert.rejects(async()=>{for await(const c of a.stream({provider:PROVIDER,model:MODEL,messages:[{role:'user',content:[{type:'text',text:'Inspect only'}]}],tools:[declared]}))chunks.push(c)},e=>e.code==='WEB_IDENTITY')
  assert.equal(f.web.generations.length,1);assert.equal(chunks.some(c=>c.block?.type==='tool-call'),false)
 }finally{await a.dispose();await f.close()}
})

test('original schema resolves structural alternatives only when their validated meaning is unique',()=>{
 const args={nested:{value:1},end:true}
 const expected={protocol_version:1,request_id:'op',kind:'tool',calls:[{name:'inspect',arguments:args}]}
 const raw=JSON.stringify(expected).replace('1},"end"','1,"end"')
 const declared={name:'inspect',parameters:{type:'object',additionalProperties:false,required:['nested','end'],properties:{nested:{type:'object',additionalProperties:false,properties:{value:{type:'integer'}},required:['value']},end:{type:'boolean'}}}}
 const schema=new StrictSchemas(),validate=(t,v)=>schema.check(t.parameters,v)
 assert.deepEqual(JSON.parse(decodeResponse(raw,[declared],'op',validate)[0].arguments),args)
 const permissive={name:'inspect',parameters:{type:'object',properties:{nested:{type:'object'},end:{type:'boolean'}}}}
 assert.throws(()=>decodeResponse(raw,[permissive],'op',validate),e=>e.code==='WEB_TOOL_FORMAT')
})

test('every grammar-repaired candidate is validated before whole-batch delivery, with no extra generation',async()=>{
 for(const correction of [false,true]){
  const f=await setup(),a=new TokenFreeAdapter({}, {store:f.store,native:f.native,credential:async()=>({token:'fixture',accountId:'fixture-owner'}),client:(_,c)=>f.web.client(f.log,c.operationId)})
  f.web.answer=(p,_,n)=>correction&&n===1?'invalid unrecognised response':broken(p.request_id)
  try{
   const chunks=await collect(a.stream({provider:PROVIDER,model:MODEL,messages:[{role:'user',content:[{type:'text',text:'Inspect only existing artifacts.'}]}],tools:[tool]}))
   assert.deepEqual(chunks.filter(c=>c.block?.type==='tool-call').map(c=>JSON.parse(c.block.arguments)),envelope('op').calls.map(c=>c.arguments))
   assert.equal(f.web.generations.length,correction?2:1)
  }finally{await a.dispose();await f.close()}
 }
})

test('independent single-edit oracle checks generated nested JSON, ambiguity and immutable scalar tokens',t=>{
 let cases=0,recovered=0,ambiguous=0
 const tokens=s=>s.match(/"(?:\\.|[^"\\])*"|true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|[{}\[\],:]/g)
 for(let seed=1;seed<=24;seed++){
  const value={['items_'+seed]:[{['id_'+seed]:seed,['flags_'+seed]:[true,false,null]},{['text_'+seed]:`literal },{ : \\n 中文 ${seed}`}],['nest_'+seed]:{['a_'+seed]:seed,['b_'+seed]:false},['end_'+seed]:0}
  const valid=tokens(JSON.stringify(value))
  for(let removed=1;removed<valid.length;removed++){
   if(!['}',']',',',':'].includes(valid[removed]))continue
   const damaged=valid.filter((_,i)=>i!==removed),raw=damaged.join(' '),answers=new Map()
   for(let at=1;at<=damaged.length;at++)for(const punctuation of ['}',']',',',':']){
    try{const candidate=strictJson([...damaged.slice(0,at),punctuation,...damaged.slice(at)].join(' '));answers.set(JSON.stringify(candidate),candidate)}catch{}
   }
   assert(answers.size>0)
   if(answers.size===1){assert.deepEqual(JSON.parse(JSON.stringify(toolJson(raw))),JSON.parse([...answers.keys()][0]));recovered++}
   else {assert.throws(()=>toolJson(raw),undefined,`seed ${seed} token ${removed}`);ambiguous++}
   cases++
  }
 }
 assert(recovered>200&&ambiguous>0)
 t.diagnostic(`${cases} generated omissions: ${recovered} unique repairs, ${ambiguous} ambiguous structures rejected against an independent exhaustive single-edit oracle`)
})

test('grammar resource budgets reject incomplete search and never invent strings, values or containers',()=>{
 for(const raw of ['['+Array(10).fill('true').join(' ')+']','['+'['.repeat(66)+'0', '["'+ 'x'.repeat(2_621_440)+'\n"]','['+Array(9000).fill('0').join(' ')+']','{"x":{','{"x":['])assert.throws(()=>toolJson(raw))
 assert.deepEqual(JSON.parse(JSON.stringify(toolJson('[1 2]'))),[1,2])
 assert.equal(toolJson('[12]')[0],12) // Valid but unintended values cannot be inferred from syntax.
 const eight=Object.fromEntries(Array.from({length:8},(_,i)=>['field_'+i,i]))
 assert.deepEqual(JSON.parse(JSON.stringify(toolJson(JSON.stringify(eight).replace(/":/g,'" ')))),eight)
})

test('multiple grammar omissions compose with lexical transport damage across arbitrary tool catalogues',t=>{
 let cases=0
 for(let seed=1;seed<=64;seed++){
  const declared={name:'inspect_'+seed,parameters:{type:'object',additionalProperties:false,properties:{description:{type:'string'},command:{type:'string'}},required:['command']}}
  const expected=[{name:declared.name,arguments:{description:'first '+seed,command:command+seed}},{name:declared.name,arguments:{command:'existing '+seed}}]
  const raw=JSON.stringify({protocol_version:1,request_id:'op',kind:'tool',calls:expected})
  for(const damage of [s=>s.replace('}},{"name"','},{"name"'),s=>s.replace('"protocol_version":','"protocol_version" ').replace('}},{"name"','},{"name"'),s=>s.replace('"request_id":','"request_id" ').replace('"kind":','"kind" ').replace('}},{"name"','},{"name"')]){
   const bad=damage(raw)
   for(const framed of [bad,'<('+bad+')>','```json\n'+bad+'\n```']){
    assert.deepEqual(decodeResponse(framed,[declared],'op').map(b=>({name:b.name,arguments:JSON.parse(b.arguments)})),expected)
    cases++
   }
  }
 }
 assert.equal(cases,576);t.diagnostic(`${cases} composed multi-omission cases across 64 catalogues preserve all command bytes`)
})
