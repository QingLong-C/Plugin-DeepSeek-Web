import {join} from 'node:path'
import {readJson,writeJson,privateDirectory} from './files.js'
import {acquireLock} from './lock.js'
import {record,TokenFreeError} from '../core/errors.js'

// CNY micro-units. Reserve the full supported 1,048,576-token context at peak
// cache-miss price (2/M) plus 8,192 output tokens at 8/M, rounded upward.
export const PAID_RESERVATION = 2_200_000
export type RepairUsage = {inputTokens:number;outputTokens:number;cacheReadTokens?:number;cacheWriteTokens?:number;reasoningTokens?:number}
type Budget = {version:1;spentMicros:number;pending:Record<string,number>}
const count=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0
const id=(v:string)=>/^[a-f0-9-]{36}$/.test(v)
export class RepairBudget {
  constructor(private readonly home:string){}
  async status():Promise<Budget>{
    const data=await readJson<unknown>(join(this.home,'repair-budget.json'))
    if(data===undefined)return {version:1,spentMicros:0,pending:{}}
    if(!record(data)||data.version!==1||!count(data.spentMicros)||!record(data.pending)||Object.entries(data.pending).some(([k,v])=>!id(k)||v!==PAID_RESERVATION))throw new TokenFreeError('付费修复预算记录损坏；未提交付费请求。','STATE_STORAGE')
    return data as Budget
  }
  async reserve(limitCny:number,requestId:string,signal:AbortSignal){
    if(!Number.isFinite(limitCny)||limitCny<=0||limitCny>6||!id(requestId))throw new TokenFreeError('Invalid repair budget.','INVALID_POLICY')
    await privateDirectory(this.home)
    const release=await acquireLock(join(this.home,'locks','repair-budget'),signal)
    try{const data=await this.status(),limit=Math.floor(limitCny*1e6)
      if(Object.hasOwn(data.pending,requestId)||data.spentMicros+Object.values(data.pending).reduce((a,b)=>a+b,0)+PAID_RESERVATION>limit)throw new TokenFreeError('付费修复预算不足以预留本次请求；未扣款发起。','REPAIR_BUDGET')
      data.pending[requestId]=PAID_RESERVATION;await writeJson(join(this.home,'repair-budget.json'),data)
    }finally{await release()}
  }
  async settle(requestId:string,usage?:RepairUsage){
    const release=await acquireLock(join(this.home,'locks','repair-budget'),AbortSignal.timeout(5000))
    try{const data=await this.status();if(!Object.hasOwn(data.pending,requestId))throw new TokenFreeError('Unknown repair reservation.','STATE_STORAGE')
      let charge=PAID_RESERVATION
      if(usage&&count(usage.inputTokens)&&count(usage.outputTokens)&&Object.values(usage).every(count)){
        const input=usage.inputTokens+(usage.cacheReadTokens??0)+(usage.cacheWriteTokens??0),output=Math.max(usage.outputTokens,usage.reasoningTokens??0)
        if(input>0&&input<=1_048_576&&output>0&&output<=8192)charge=input*2+output*8
      }
      data.spentMicros+=charge;delete data.pending[requestId];if(!count(data.spentMicros))throw new TokenFreeError('Invalid budget sum.','STATE_STORAGE')
      await writeJson(join(this.home,'repair-budget.json'),data)
    }finally{await release()}
  }
}
