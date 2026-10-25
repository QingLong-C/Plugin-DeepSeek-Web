import {test} from 'node:test'
import assert from 'node:assert/strict'
import {webUsageReport} from '../lib/core/usage-report.js'
const observedAt='2026-10-26T00:00:00.000Z'
const row=(id,count=40)=>({sessionId:id,sessionKey:id,accountKey:'owner',metricsEpoch:1,metricsCurrent:true,chatId:'chat-'+id,parentId:2,
 usage:{accumulated_token_usage:count,chatId:'chat-'+id,messageId:2,source:'history',observedAt}})
function fixture(rows){let account={epoch:1,accountKey:'owner'};const pending=new Set();return {account:v=>{account=v},pending,store:{account:async()=>account,sessionKeys:async()=>Object.keys(rows),session:async key=>{if(rows[key] instanceof Error)throw rows[key];return rows[key]},pending:async key=>pending.has(key)?{}:undefined}}}
test('report preserves official zero, isolates accounts/profiles, skips corrupt rows visibly, never sums or invents billing',async()=>{
 const f=fixture({a:row('a',0),b:row('b',123),other:{...row('other'),accountKey:'else'},profile:row('else'),broken:new Error('corrupt')})
 const report=await webUsageReport(f.store,id=>id)
 assert.equal(report.rows.length,2);assert.equal(report.unreadableSessions,1)
 assert.deepEqual(report.rows.map(r=>r.count).sort((a,b)=>a-b),[0,123])
 assert.equal(report.rows[0].state,'confirmed');assert.equal('totalTokens' in report,false);assert.equal('cost' in report,false)
 assert.equal(JSON.stringify(report).includes('accountKey'),false)
})
test('pending, invalidated metrics and older epochs are old observations, missing counts stay unknown',async()=>{
 const f=fixture({a:row('a'),b:{...row('b'),metricsCurrent:false},c:{...row('c'),metricsEpoch:0},d:{...row('d'),usage:undefined}});f.pending.add('a')
 const report=await webUsageReport(f.store,id=>id)
 for(const r of report.rows){assert.equal(r.count,undefined);if(r.sessionId!=='d')assert.equal(r.previousCount,40)}
 assert.equal(report.rows.find(r=>r.sessionId==='a').pending,true)
 assert.equal(report.rows.find(r=>r.sessionId==='d').state,'unknown')
})
test('logout and account changes during reading discard the report; repeat reads do not accumulate',async()=>{
 const f=fixture({a:row('a')});const first=await webUsageReport(f.store,id=>id),second=await webUsageReport(f.store,id=>id)
 assert.deepEqual(first.rows,second.rows)
 f.account({epoch:2,accountKey:'owner',credentialHash:null});assert.equal((await webUsageReport(f.store,id=>id)).rows.length,0)
 f.account({epoch:1,accountKey:'owner'});const read=f.store.session;f.store.session=async k=>{f.account({epoch:2,accountKey:'other'});return read(k)}
 assert.equal((await webUsageReport(f.store,id=>id)).rows.length,0)
})
