import type {Context} from '@deepseek-ai/cordis'
import {APP_IDENTITY,BlockAssembler,ReasoningEffortId} from '@deepseek-ai/dsh-llm'
import {randomUUID} from 'node:crypto'
import {TokenFreeError,record} from '../core/errors.js'
import type {RepairRelay} from '../core/recovery.js'
import {RepairBudget,PAID_RESERVATION,type RepairUsage} from '../local/repair-budget.js'
import type {LocalDiagnostics} from '../local/diagnostics.js'

export type RelayConfig = {routes:{provider:string;model:string}[];paid?:{budgetCny:number;pricingVerifiedAt:string}}
function bounded<T>(pending:Promise<T>,signal:AbortSignal):Promise<T>{
  return new Promise((resolve,reject)=>{
    const abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true})
    pending.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort))
    if(signal.aborted)abort()
  })
}
const freeProviders=new Set(['raccoon','minimax','qodercn','qoder','loomy','gemini','zcode','codearts','eac','tokenharbor'])
function balanceMicros(value:unknown):number{
  if(!record(value)||value.status!=='ready'||!Array.isArray(value.value)||!Array.isArray(value.bonusWallets))throw new TokenFreeError('官方账号余额不可确认，跳过付费修复。','REPAIR_BUDGET')
  let total=0
  for(const wallet of [...value.value,...value.bonusWallets]){if(!record(wallet)||wallet.currency!=='CNY')continue;const n=Number(wallet.balance);if(!Number.isFinite(n)||n<0)throw new TokenFreeError('Invalid account balance.','REPAIR_BUDGET');total+=Math.floor(n*1e6)}
  return total
}
/** Only invoked after confirmed format failure and the existing Web repair budget. */
export function createRepairRelay(ctx:Context,home:string,config:RelayConfig,log?:LocalDiagnostics):RepairRelay{
  if(!Array.isArray(config.routes)||config.routes.length>10||config.routes.some(r=>!freeProviders.has(r.provider)||!r.model||r.model.length>200)||new Set(config.routes.map(r=>r.provider+'/'+r.model)).size!==config.routes.length)throw new Error('Invalid free repair routes')
  if(config.paid&&(!Number.isFinite(config.paid.budgetCny)||config.paid.budgetCny<=0||config.paid.budgetCny>6||!Number.isFinite(Date.parse(config.paid.pricingVerifiedAt))))throw new Error('Invalid paid repair budget')
  config=structuredClone(config)
  const budget=new RepairBudget(home)
  return async request=>{
    const signal=AbortSignal.any([request.signal,AbortSignal.timeout(600_000)]),failures:string[]=[]
    // No truncation: avoid sending a partial task or exceeding the paid model's full context.
    if(Buffer.byteLength(request.prompt,'utf8')>1_000_000)throw new TokenFreeError('修复上下文超出后备通道上限；未截断任务，请手动处理。','WEB_TOOL_FORMAT')
    const routes=[...config.routes,...(config.paid?[{provider:'deepseek-account',model:'deepseek-flash'}]:[])]
    const seen=new Set<string>()
    for(const route of routes){
      signal.throwIfAborted()
      const attemptSignal=AbortSignal.any([signal,AbortSignal.timeout(60_000)]),paid=route.provider==='deepseek-account',attemptId=randomUUID()
      let reserved=false,usage:RepairUsage|undefined,complete=false
      try{
        if(!(await bounded(ctx.llm.listModels(route.provider),attemptSignal)).some(m=>m.id===route.model))throw new TokenFreeError('模型当前不在可用目录。','MODEL_UNSUPPORTED')
        const info=await bounded(ctx.llm.resolveModelInfo(route.provider,route.model,attemptSignal),attemptSignal)
        if(paid){
          const age=Date.now()-Date.parse(config.paid!.pricingVerifiedAt)
          if(age<0||age>30*86400_000)throw new TokenFreeError('付费修复价格核验已过期。','REPAIR_BUDGET')
          const account=ctx.get('deepseekAccount') as {getBalance?:(client:{version:string;locale:string;timezoneOffsetSeconds:number})=>Promise<unknown>}|undefined
          const balance=await bounded(Promise.resolve(account?.getBalance?.({version:APP_IDENTITY.version,locale:'zh-CN',timezoneOffsetSeconds:28800})),attemptSignal)
          if(balanceMicros(balance)<PAID_RESERVATION)throw new TokenFreeError('官方余额不足以保守预留本次修复。','REPAIR_BUDGET')
          attemptSignal.throwIfAborted();await budget.reserve(config.paid!.budgetCny,attemptId,attemptSignal);reserved=true
        }
        log?.content(request.operationId,'repair.relay',{stage:'started',...route,paid,attemptId})
        const assembler=new BlockAssembler();let finished=false,size=0
        const off=info.reasoning?.efforts.find(x=>x.id==='off'||x.id==='none')
        const stream=ctx.llm.stream({provider:route.provider,model:route.model,messages:[{role:'user',content:[{type:'text',text:request.prompt}]}],tools:[],maxTokens:8192,...(off?{reasoningEffort:ReasoningEffortId(off.id)}:{}),signal:attemptSignal})
        const iterator=stream[Symbol.asyncIterator]()
        try { for(;;){
          const item=await bounded(iterator.next(),attemptSignal);if(item.done)break
          const chunk=item.value
          attemptSignal.throwIfAborted();if(finished)throw new TokenFreeError('修复流在结束后继续输出。','WEB_TOOL_FORMAT')
          if(chunk.type==='text-delta'||chunk.type==='reasoning-delta')size+=chunk.text.length
          if(chunk.type==='block-end'&&chunk.block.type==='text')size+=chunk.block.text.length
          if(size>262144||chunk.type==='tool-call-delta'||chunk.type==='block-end'&&chunk.block.type==='tool-call')throw new TokenFreeError('修复模型返回了工具调用或超长输出。','WEB_TOOL_FORMAT')
          assembler.push(chunk)
          if(chunk.type==='usage')usage=chunk.usage
          if(chunk.type==='finish'){finished=true;if(chunk.reason.kind!=='stop')throw new TokenFreeError('修复模型未完整结束。','WEB_TOOL_FORMAT');complete=true}
        }
        } finally { void Promise.resolve(iterator.return?.()).catch(()=>{}) }
        if(!finished)throw new TokenFreeError('修复流缺少完成标记。','WEB_TOOL_FORMAT')
        const text=assembler.blocks().filter(b=>b.type==='text').map(b=>b.text).join('\n')
        if(!text.trim()||seen.has(text))throw new TokenFreeError('修复候选为空或与已失败候选相同。','WEB_TOOL_FORMAT')
        seen.add(text);request.validate(text)
        log?.content(request.operationId,'repair.relay',{stage:'validated',...route,paid,attemptId})
        return {text,...route}
      }catch(error){
        signal.throwIfAborted()
        const code=record(error)&&typeof error.code==='string'?error.code:'UNAVAILABLE'
        failures.push(route.provider+'/'+route.model+':'+code)
        log?.content(request.operationId,'repair.relay',{stage:'failed',...route,paid,attemptId,code})
      }finally{if(reserved)await budget.settle(attemptId,complete?usage:undefined)}
    }
    throw new TokenFreeError(`当前网页纠正及后备修复均未通过；本步骤未派发工具，请手动处理。渠道结果：${failures.join('；')}`,'WEB_TOOL_FORMAT')
  }
}
