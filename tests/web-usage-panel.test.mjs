import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,mkdir} from 'node:fs/promises'
import {resolve,join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {build} from 'esbuild'
import {JSDOM} from 'jsdom'
import {SlotCore} from '@deepseek-ai/dsh-client-ui-slots'

test('web usage panel preserves official zero, separates stale/unknown and billing; refresh failures clear old displays',async()=>{
 const dom=new JSDOM('<html><body></body></html>',{url:'https://dsh.test/'});globalThis.window=dom.window;globalThis.document=dom.window.document;globalThis.HTMLElement=dom.window.HTMLElement;globalThis.IS_REACT_ACT_ENVIRONMENT=true
 const React=await import('react'),{render,cleanup,waitFor,fireEvent}=await import('@testing-library/react')
 await mkdir(resolve('.local'),{recursive:true});const dir=await mkdtemp(resolve('.local','web-usage-ui-')),file=join(dir,'view.mjs')
 await build({entryPoints:['src/dsh/client/WebUsagePanel.tsx'],outfile:file,bundle:true,format:'esm',platform:'node',jsx:'automatic',external:['react','react/jsx-runtime']})
 const {WebUsagePanel,installWebUsagePanel}=await import(pathToFileURL(file).href)
 let fail=false,calls=0
 const report={unreadableSessions:1,rows:[{sessionId:'one',state:'confirmed',count:0,pending:false,observedAt:'2026-10-26T00:00:00Z'},{sessionId:'two',state:'stale',previousCount:12000,pending:true},{sessionId:'three',state:'unknown',pending:false}]}
 const load=async()=>{calls++;if(fail)throw Error('offline');return report}
 try{
  const ui=render(React.createElement(WebUsagePanel,{load}));await waitFor(()=>assert.ok(ui.getByText('0',{selector:'td'})))
  assert.ok(ui.getByText('12,000（旧观测）'));assert.ok(ui.getByText('处理中，待结算'));assert.match(ui.container.textContent,/不计入下方 API token、费用和缓存命中率/)
  assert.match(ui.container.textContent,/1 份会话记录无法读取/)
  fail=true;fireEvent.click(ui.getByRole('button',{name:'刷新网页用量'}));await waitFor(()=>assert.match(ui.container.textContent,/读取失败/));assert.equal(ui.queryByText('12,000（旧观测）'),null)
  cleanup();fail=false
  const core=new SlotCore();core.register({name:'root',children:{main:{kind:'keyed',scope:'root'}}},()=>null)
  const slots={inject:(_key,fn)=>fn(),entries:core.entries.bind(core),subscribe:core.subscribe.bind(core),register:core.register.bind(core)}
  const stop=installWebUsagePanel({slots},load)
  const original=props=>React.createElement('div',null,'API_ORIGINAL:'+props.marker)
  const inject=()=>({marker:'unchanged'})
  const remove=core.register({name:'main',key:'usage',locale:'usage',inject},original)
  await new Promise(queueMicrotask)
  const winner=()=>core.entriesOfSlot('main')[0]
  assert.notEqual(winner().component,original);assert.equal(winner().inject,inject);assert.equal(winner().locale,'usage')
  const panel=render(React.createElement(winner().component,{marker:'unchanged'}));await waitFor(()=>assert.ok(panel.getByText('API_ORIGINAL:unchanged')));await waitFor(()=>assert.ok(panel.getByText('0',{selector:'td'})))
  cleanup();remove();await new Promise(queueMicrotask);assert.equal(core.entries('main').length,0)
  const remove2=core.register({name:'main',key:'usage',locale:'usage',inject},original);await new Promise(queueMicrotask);assert.notEqual(winner().component,original)
  stop();assert.equal(winner().component,original);remove2();assert(calls>=3)
 }finally{cleanup();dom.window.close();await rm(dir,{recursive:true,force:true})}
})
