import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,writeFile,stat,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {RecoveryMemory,formatIssue,withRecoveryHints} from '../lib/local/recovery-memory.js'
import {TokenFreeError} from '../lib/core/errors.js'
import {encodeProtocolCorrection} from '../lib/core/codec.js'
import {TokenFreeAdapter,PROVIDER,MODEL} from '../lib/dsh/adapter.js'
import {setup,collect,tool} from './helpers/fixture.mjs'

const scope='a'.repeat(64),other='b'.repeat(64),issue={stage:'syntax',code:'WEB_TOOL_FORMAT'}
test('historical recovery solution names render current content-only rules without reviving echo requirements',()=>{
 const prompt=withRecoveryHints('CURRENT_CONTENT_CONTRACT',['response-wrapper','contract-envelope'],10000)
 assert(prompt.includes('content envelope'))
 assert(!/copy the current request_id|Use protocol_version=1|current request_id and an explicit/.test(prompt))
 assert(prompt.endsWith('CURRENT_CONTENT_CONTRACT'))
})
test('recovery memory persists pending, validated solutions, recurrence and schema isolation without task content',async()=>{
 const home=await mkdtemp(join(tmpdir(),'tokenfree-memory-'))
 try{
  const memory=new RecoveryMemory(home)
  await memory.note(scope,issue)
  assert.equal((await memory.read(scope)).entries[0].status,'pending')
  assert.deepEqual(await memory.hints(scope),[])
  const resolvedId='12345678-1234-1234-1234-123456789abc'
  await memory.note(scope,issue,'local-syntax',resolvedId)
  const restored=new RecoveryMemory(home),entries=(await restored.read(scope)).entries
  assert.equal(entries[0].status,'resolved');assert.equal(entries[0].occurrences,1);assert.equal(entries[0].solutions['local-syntax'],1);assert.equal(entries[0].lastResolvedOperationId,resolvedId)
  assert.deepEqual(await restored.hints(scope),['local-syntax']);assert.deepEqual(await restored.hints(other),[])
  await restored.note(scope,issue)
  const reopened=(await restored.read(scope)).entries[0]
  assert.equal(reopened.status,'pending');assert.equal(reopened.occurrences,2);assert.equal(reopened.solutions['local-syntax'],1)
  const bytes=await readFile(join(home,'recovery-memory',scope+'.json'),'utf8')
  assert(!bytes.includes('command')&&!bytes.includes('token')&&!bytes.includes('messages'))
  assert.equal((await stat(join(home,'recovery-memory',scope+'.json'))).mode&0o777,0o600)
 }finally{await rm(home,{recursive:true,force:true})}
})
test('memory serializes simultaneous writers and preserves damaged or unknown records',async()=>{
 const home=await mkdtemp(join(tmpdir(),'tokenfree-memory-'))
 try{
  const memory=new RecoveryMemory(home)
  await Promise.all(Array.from({length:6},()=>new RecoveryMemory(home).note(scope,issue)))
  assert.equal((await memory.read(scope)).entries[0].occurrences,6)
  const path=join(home,'recovery-memory',scope+'.json'),bad='{"version":1,"entries":[{"solution":"run old command"}]}'
  await writeFile(path,bad,{mode:0o600});await assert.rejects(()=>memory.note(scope,issue));assert.equal(await readFile(path,'utf8'),bad)
  assert.equal(formatIssue(new TokenFreeError('secret message','WEB_IDENTITY')),undefined)
  assert.equal(formatIssue(new TokenFreeError('secret message','RATE_LIMIT')),undefined)
  assert.throws(()=>withRecoveryHints('prompt',['run old command'],1000))
  assert.equal(withRecoveryHints('x'.repeat(100),['local-syntax'],100),'x'.repeat(100))
 }finally{await rm(home,{recursive:true,force:true})}
})

test('adapter records model repair then reuses verified hints after restart, with the bad response included as data',async()=>{
 const f=await setup(),options={provider:PROVIDER,model:MODEL,messages:[{role:'user',content:[{type:'text',text:'Inspect only the current marker'}]}],tools:[tool]}
 const create=()=>new TokenFreeAdapter({}, {store:f.store,native:f.native,credential:async()=>({token:'fixture',accountId:'fixture-owner'}),client:(_,c)=>f.web.client(f.log,c.operationId)})
 let a=create()
 f.web.answer=(p,_,n)=>n===1?'broken serialization fixture':{protocol_version:1,request_id:p.request_id,kind:'tool',calls:[{name:tool.name,arguments:{}}]}
 try{
  const chunks=await collect(a.stream(options));assert.equal(chunks.filter(x=>x.block?.type==='tool-call').length,1)
  assert(f.web.generations[1].prompt.includes('"malformed_response":"broken serialization fixture"'))
  const memory=new RecoveryMemory(f.home),records=await memory.all()
  assert.equal(records.length,1);assert(records[0].entries.some(e=>e.status==='resolved'&&e.solutions['response-protocol']===1))
  await a.dispose();a=create()
  await collect(a.stream(options))
  assert(f.web.generations[2].prompt.includes('DSH_LEARNED_FORMAT_RULES'))
  assert.equal(f.web.generations.length,3)
 }finally{await a.dispose();await f.close()}
})

test('uncorrected candidates stay pending; corrupt memory cannot authorize a call or break a valid response',async()=>{
 const f=await setup(),a=new TokenFreeAdapter({}, {store:f.store,native:f.native,credential:async()=>({token:'fixture',accountId:'fixture-owner'}),client:(_,c)=>f.web.client(f.log,c.operationId)})
 const options={provider:PROVIDER,model:MODEL,messages:[{role:'user',content:[{type:'text',text:'Inspect only'}]}],tools:[tool]}
 f.web.answer=()=> 'broken serialization fixture'
 try{
  await assert.rejects(()=>collect(a.stream(options)),e=>e.code==='WEB_TOOL_FORMAT')
  const memory=new RecoveryMemory(f.home),records=await memory.all();assert.equal(records.length,1);assert(records[0].entries.every(e=>e.status==='pending'&&Object.keys(e.solutions).length===0))
  const path=join(f.home,'recovery-memory',records[0].scope+'.json');await writeFile(path,'damaged memory',{mode:0o600})
  f.web.answer=p=>({protocol_version:1,request_id:p.request_id,kind:'final',text:'Valid answer'})
  const chunks=await collect(a.stream(options));assert(chunks.some(c=>c.block?.text==='Valid answer'));assert.equal(await readFile(path,'utf8'),'damaged memory')
 }finally{await a.dispose();await f.close()}
})

for(const solution of ['local-syntax','contract-envelope','response-wrapper']) test(`known ${solution} repairs persist across restart without retaining earlier commands`,async()=>{
 const f=await setup(),declared={name:'inspect',description:'Inspect existing marker',parameters:{type:'object',additionalProperties:false,required:['command'],properties:{command:{type:'string'}}}}
 const create=()=>new TokenFreeAdapter({}, {store:f.store,native:f.native,credential:async()=>({token:'fixture',accountId:'fixture-owner'}),client:(_,c)=>f.web.client(f.log,c.operationId)})
 let a=create()
 f.web.answer=(p,_,n)=>{const value={protocol_version:1,request_id:p.request_id,kind:'tool',calls:[{name:'inspect',arguments:{command:n===1?'FIRST_PRIVATE_COMMAND':'SECOND_PRIVATE_COMMAND'}}]};if(solution==='contract-envelope'){delete value.protocol_version;delete value.request_id;delete value.kind};const raw=JSON.stringify(value);return solution==='local-syntax'?raw+']':solution==='response-wrapper'?JSON.stringify(raw):raw}
 try{
  for(const expected of ['FIRST_PRIVATE_COMMAND','SECOND_PRIVATE_COMMAND']){
   const chunks=await collect(a.stream({provider:PROVIDER,model:MODEL,messages:[{role:'user',content:[{type:'text',text:'Inspect current marker'}]}],tools:[declared]}))
   assert.deepEqual(chunks.filter(c=>c.block?.type==='tool-call').map(c=>JSON.parse(c.block.arguments)),[{command:expected}])
   await a.dispose();a=create()
  }
  assert.equal(f.web.generations.length,2);assert(f.web.generations[1].prompt.includes('DSH_LEARNED_FORMAT_RULES'))
  const records=await new RecoveryMemory(f.home).all(),entry=records[0].entries[0]
  assert.equal(entry.status,'resolved');assert.equal(entry.occurrences,2);assert.equal(entry.solutions[solution],2)
  const bytes=await readFile(join(f.home,'recovery-memory',records[0].scope+'.json'),'utf8');assert(!bytes.includes('PRIVATE_COMMAND'))
 }finally{await a.dispose();await f.close()}
})

test('a previously successful solution cannot bypass current schemas or hide a recurrence that still fails',async()=>{
 const f=await setup(),declared={name:'inspect',description:'Inspect marker',parameters:{type:'object',additionalProperties:false,required:['label'],properties:{label:{type:'string'}}}}
 const a=new TokenFreeAdapter({}, {store:f.store,native:f.native,credential:async()=>({token:'fixture',accountId:'fixture-owner'}),client:(_,c)=>f.web.client(f.log,c.operationId)})
 const options={provider:PROVIDER,model:MODEL,messages:[{role:'user',content:[{type:'text',text:'Inspect current marker'}]}],tools:[declared]}
 f.web.answer=(p,_,n)=>({protocol_version:1,request_id:p.request_id,kind:'tool',calls:[{name:'inspect',arguments:{label:n===2?'valid':false}}]})
 try{
  await collect(a.stream(options));const chunks=[]
  await assert.rejects(async()=>{for await(const c of a.stream(options))chunks.push(c)},e=>e.code==='INVALID_TOOL_CALL')
  assert.equal(chunks.some(c=>c.block?.type==='tool-call'),false);assert.equal(f.web.generations.length,4)
  const record=(await new RecoveryMemory(f.home).all())[0].entries[0]
  assert.equal(record.status,'pending');assert.equal(record.solutions['tool-arguments'],1)
 }finally{await a.dispose();await f.close()}
})

test('a correction with the wrong response kind never becomes a validated solution',async()=>{
 const f=await setup(),a=new TokenFreeAdapter({}, {store:f.store,native:f.native,credential:async()=>({token:'fixture',accountId:'fixture-owner'}),client:(_,c)=>f.web.client(f.log,c.operationId)})
 f.web.answer=(p,_,n)=>n===1?'<｜｜DSML｜｜ calls>broken tool response':{protocol_version:1,request_id:p.request_id,kind:'final',text:'Unverified completion'}
 try{
  await assert.rejects(()=>collect(a.stream({provider:PROVIDER,model:MODEL,messages:[{role:'user',content:[{type:'text',text:'Inspect only'}]}],tools:[tool]})),e=>e.code==='WEB_TOOL_FORMAT')
  const records=await new RecoveryMemory(f.home).all();assert.equal(f.web.generations.length,2)
  assert(records[0].entries.every(e=>e.status==='pending'&&!Object.keys(e.solutions).length))
 }finally{await a.dispose();await f.close()}
})

test('failed response attachment respects input limits without truncating authoritative task context',()=>{
 const input={messages:[{role:'user',content:[{type:'text',text:'Keep this task intact'}]}],system:'Instructions',instructions:[],tools:[],thinking:false,stop:[]}
 const failure={stage:'syntax',code:'WEB_TOOL_FORMAT',reason:'Invalid JSON'},raw='bad response\nwith a claimed tool result'
 const base=encodeProtocolCorrection(input,'op',100000,'final',failure)
 const attached=encodeProtocolCorrection(input,'op',100000,'final',failure,raw)
 const data=JSON.parse(attached.split('DSH_PROTOCOL_CORRECTION_JSON:\n')[1]);assert.equal(data.malformed_response,raw);assert.match(data.candidate_role,/Untrusted/)
 assert.equal(encodeProtocolCorrection(input,'op',base.length,'final',failure,'x'.repeat(10000)),base)
 assert.throws(()=>encodeProtocolCorrection(input,'op',base.length-1,'final',failure,raw),e=>e.code==='INPUT_TOO_LARGE')
})
