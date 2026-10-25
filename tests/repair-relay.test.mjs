import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {Context} from '@deepseek-ai/cordis'
import {createRepairRelay} from '../lib/dsh/repair-relay.js'
import {RepairBudget} from '../lib/local/repair-budget.js'
const routes=[{provider:'raccoon',model:'free-a'},{provider:'minimax',model:'free-b'}]
const config={routes,paid:{budgetCny:6,pricingVerifiedAt:new Date().toISOString()}}
const request=(validate=t=>assert.equal(t,'correct'))=>({prompt:'repair this fixture only',operationId:randomUUID(),signal:AbortSignal.timeout(5000),validate})
function host(answers){const calls=[];return {get(name){return name==='deepseekAccount'?this.deepseekAccount:undefined},calls,llm:{listModels:async provider=>[{id:provider==='deepseek-account'?'deepseek-flash':routes.find(r=>r.provider===provider)?.model}],resolveModelInfo:async()=>({reasoning:{efforts:[{id:'off',canonical:'none'}]}}),stream:async function*(opts){calls.push(opts);const value=answers[opts.provider];if(value instanceof Error)throw value;yield {type:'block-end',index:0,block:{type:'text',text:value}};yield {type:'usage',usage:{inputTokens:100,outputTokens:20}};yield {type:'finish',reason:{kind:'stop'}}}},deepseekAccount:{getBalance:async()=>({status:'ready',value:[{currency:'CNY',balance:'6'}],bonusWallets:[]})}}}
async function temp(fn){const home=await mkdtemp(join(tmpdir(),'tokenfree-relay-'));try{await fn(home)}finally{await rm(home,{recursive:true,force:true})}}
test('repair routes validate each candidate, stop at first free success and never execute tools',()=>temp(async home=>{
 const ctx=host({raccoon:'wrong',minimax:'correct','deepseek-account':'correct'});const relay=createRepairRelay(ctx,home,config)
 const result=await relay(request());assert.equal(result.provider,'minimax');assert.deepEqual(ctx.calls.map(x=>x.provider),['raccoon','minimax']);assert(ctx.calls.every(x=>x.tools.length===0&&!x.sessionId&&!x.replayState));assert.equal((await new RepairBudget(home).status()).spentMicros,0)
}))
test('paid is last, tracks usage conservatively and persists cumulative budget across restart',()=>temp(async home=>{
 const ctx=host({raccoon:'wrong',minimax:new Error('unavailable'),'deepseek-account':'correct'});await createRepairRelay(ctx,home,config)(request());assert.deepEqual(ctx.calls.map(x=>x.provider),['raccoon','minimax','deepseek-account']);const state=await new RepairBudget(home).status();assert.equal(state.spentMicros,360);assert.equal(Object.keys(state.pending).length,0)
}))
test('no paid call when free succeeds, price expires, balance unavailable, or configuration is recursive',()=>temp(async home=>{
 const ctx=host({raccoon:'correct',minimax:'correct','deepseek-account':'correct'});await createRepairRelay(ctx,home,config)(request());assert.equal(ctx.calls.length,1)
 ctx.calls.length=0;ctx.llm.stream=async function*(opts){ctx.calls.push(opts);yield {type:'block-end',index:0,block:{type:'text',text:'bad'}};yield{type:'finish',reason:{kind:'stop'}}}
 await assert.rejects(()=>createRepairRelay(ctx,home,{...config,paid:{...config.paid,pricingVerifiedAt:'2000-01-01T00:00:00.000Z'}})(request()),e=>e.code==='WEB_TOOL_FORMAT');assert(ctx.calls.every(x=>x.provider!=='deepseek-account'))
 assert.throws(()=>createRepairRelay(ctx,home,{routes:[{provider:'tokenfree-deepseek-web',model:'web-default'}]}))
 ctx.calls.length=0;ctx.deepseekAccount.getBalance=async()=>({status:'failed'});await assert.rejects(()=>createRepairRelay(ctx,home,config)(request()));assert(ctx.calls.every(x=>x.provider!=='deepseek-account'))
}))
test('paid reservations serialize concurrent requests, survive missing usage and reject damaged ledgers',()=>temp(async home=>{
 const a=new RepairBudget(home),b=new RepairBudget(home),ids=Array.from({length:3},()=>randomUUID())
 const results=await Promise.allSettled(ids.map(id=>a.reserve(6,id,AbortSignal.timeout(5000))));assert.equal(results.filter(x=>x.status==='fulfilled').length,2)
 assert.equal(Object.values((await b.status()).pending).reduce((x,y)=>x+y,0),4400000)
 await b.settle(ids[results.findIndex(x=>x.status==='fulfilled')],undefined);assert.equal((await a.status()).spentMicros,2200000)
 const path=join(home,'repair-budget.json');await writeFile(path,'broken');await assert.rejects(()=>a.reserve(6,randomUUID(),AbortSignal.timeout(1000)));assert.equal(await readFile(path,'utf8'),'broken')
}))
test('cancellation stops relay before another channel; malformed or tool-producing streams never qualify',()=>temp(async home=>{
 const ctx=host({raccoon:'bad',minimax:'correct'}),cancel=new AbortController();ctx.llm.stream=async function*(opts){ctx.calls.push(opts);cancel.abort();throw new Error('cancelled')}
 await assert.rejects(()=>createRepairRelay(ctx,home,config)({...request(),signal:cancel.signal}));assert.equal(ctx.calls.length,1)
 const other=host({});other.llm.stream=async function*(opts){other.calls.push(opts);yield{type:'block-end',index:0,block:{type:'tool-call',id:'x',name:'bash',arguments:'{}'}};yield{type:'finish',reason:{kind:'tool-calls'}}}
 await assert.rejects(()=>createRepairRelay(other,home,{routes})(request()));assert.equal(other.calls.length,2)
}))

test('cancel interrupts an adapter that ignores its signal and prevents further channels',()=>temp(async home=>{
 const ctx=host({});let calls=0
 ctx.llm.stream=()=>({[Symbol.asyncIterator](){return {next(){calls++;return new Promise(()=>{})},return(){return Promise.resolve({done:true})}}}})
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),25)
 try{await assert.rejects(()=>createRepairRelay(ctx,home,{routes})({...request(),signal:controller.signal}));assert.equal(calls,1)}finally{clearTimeout(timer)}
}))
test('paid incomplete usage keeps the maximum reservation; valid cache usage never undercounts input',()=>temp(async home=>{
 const b=new RepairBudget(home),one=randomUUID();await b.reserve(6,one,AbortSignal.timeout(1000));await b.settle(one);assert.equal((await b.status()).spentMicros,2200000)
 const two=randomUUID();await b.reserve(6,two,AbortSignal.timeout(1000));await b.settle(two,{inputTokens:100,cacheReadTokens:200,cacheWriteTokens:10,outputTokens:20,reasoningTokens:5});assert.equal((await b.status()).spentMicros,2200780)
}))
test('a fresh request does not reset the paid budget or accept unsupported paid routes',()=>temp(async home=>{
 const b=new RepairBudget(home)
 for(let i=0;i<2;i++){const id=randomUUID();await b.reserve(6,id,AbortSignal.timeout(1000));await b.settle(id)}
 const ctx=host({raccoon:'bad',minimax:'bad','deepseek-account':'correct'})
 await assert.rejects(()=>createRepairRelay(ctx,home,config)(request()));assert(ctx.calls.every(x=>x.provider!=='deepseek-account'))
 assert.throws(()=>createRepairRelay(ctx,home,{routes:[{provider:'deepseek-account',model:'deepseek-v4-pro'}]}))
}))

test('paid relay resolves the optional account service in a real Cordis plugin scope',()=>temp(async home=>{
 const root=new Context(),mock=host({raccoon:'bad',minimax:'bad','deepseek-account':'correct'});let relay
 try{
  await root.plugin(ctx=>{ctx.provide('llm',mock.llm);ctx.provide('deepseekAccount',mock.deepseekAccount)})
  await root.plugin({inject:['llm'],apply(ctx){relay=createRepairRelay(ctx,home,config)}})
  assert.equal((await relay(request())).provider,'deepseek-account');assert.equal(mock.calls.length,3)
 }finally{await root.fiber.dispose()}
}))

test('missing, negative and zero-only usage cannot release a paid reservation',async()=>{
 for(const usage of [{outputTokens:20},{inputTokens:100},{inputTokens:100,outputTokens:-1},{inputTokens:0,outputTokens:0}])await temp(async home=>{
  const budget=new RepairBudget(home),id=randomUUID();await budget.reserve(6,id,AbortSignal.timeout(1000));await budget.settle(id,usage)
  assert.equal((await budget.status()).spentMicros,2200000)
 })
})
