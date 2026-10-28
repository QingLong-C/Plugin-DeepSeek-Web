import {join} from 'node:path'
import {readdir} from 'node:fs/promises'
import {TokenFreeError,record} from '../core/errors.js'
import {WebResponseFormatError} from '../core/codec.js'
import {privateDirectory,readJson,writeJson} from './files.js'
import {acquireLock} from './lock.js'

const guides = {
  'local-syntax': 'Validate JSON punctuation and string escaping before returning; no trailing commas or characters outside the complete root.',
  'tool-arguments': 'Check the current original tool schemas: required fields, exact types and nesting. Do not coerce values or invent missing task facts.',
  'tool-protocol': 'When tools are needed, serialize their exact available names and arguments as a tool envelope; never claim unexecuted results.',
  'response-wrapper': 'Return only the content envelope: kind plus text or calls. Routing metadata belongs to the host and must not be echoed.',
  'final-response': 'For a final answer, put the complete answer in JSON final.text with escaped newlines; follow the current output schema.',
  'contract-envelope': 'Emit one complete content envelope with an explicit kind matching its calls or text; omit routing metadata.',
  'response-protocol': 'Return one complete JSON envelope under the current response_policy. Keep tool calls separate from final answers.',
} as const
export type RecoverySolution = keyof typeof guides
export type FormatIssue = {stage:string;code:string}
interface Entry extends FormatIssue {status:'pending'|'resolved';occurrences:number;solutions:Partial<Record<RecoverySolution,number>>;firstAt:string;lastAt:string;lastOperationId?:string;lastResolvedOperationId?:string}
interface Memory {version:1;scope:string;entries:Entry[]}
const stages=new Set(['syntax','envelope','tool','wrapper','arguments','policy','output'])
const codes=new Set(['WEB_TOOL_FORMAT','INVALID_TOOL_CALL','TOOL_CHOICE','OUTPUT_FORMAT','OUTPUT_SCHEMA'])
const hash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)
const count=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0
const time=(v:unknown):v is string=>typeof v==='string'&&v.length===24&&Number.isFinite(Date.parse(v))
const operation=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9-]{36}$/.test(v)
export function formatIssue(error:unknown):FormatIssue|undefined {
  if(!(error instanceof TokenFreeError)||!codes.has(error.code))return
  return {stage:error instanceof WebResponseFormatError?error.stage:error.code==='INVALID_TOOL_CALL'?'arguments':error.code==='TOOL_CHOICE'?'policy':error.code==='WEB_TOOL_FORMAT'?'envelope':'output',code:error.code}
}
/** Fixed serialization advice only: never load executable repairs, old arguments or model-written instructions. */
export function withRecoveryHints(prompt:string,solutions:readonly RecoverySolution[],limit:number):string {
  if(solutions.some(s=>!Object.hasOwn(guides,s)))throw new Error('Unknown recovery solution')
  if(!solutions.length)return prompt
  const note='DSH_LEARNED_FORMAT_RULES (serialization only; current task and policy remain authoritative):\n'+[...new Set(solutions)].sort().map(s=>guides[s]).join('\n')+'\n\n'
  return note.length+prompt.length<=limit?note+prompt:prompt
}
export class RecoveryMemory {
  private readonly directory:string
  constructor(home:string){this.directory=join(home,'recovery-memory')}
  async read(scope:string):Promise<Memory>{
    if(!hash(scope))throw new Error('Invalid recovery scope')
    const value=await readJson<unknown>(join(this.directory,scope+'.json'))
    if(value===undefined)return {version:1,scope,entries:[]}
    if(!record(value)||value.version!==1||value.scope!==scope||!Array.isArray(value.entries)||value.entries.length>64)throw new Error('Invalid recovery memory; preserved')
    const keys=new Set<string>(),entries:Entry[]=[]
    for(const e of value.entries){
      if(!record(e)||typeof e.stage!=='string'||!stages.has(e.stage)||typeof e.code!=='string'||!codes.has(e.code)||!['pending','resolved'].includes(String(e.status))||!count(e.occurrences)||!time(e.firstAt)||!time(e.lastAt)||!record(e.solutions))throw new Error('Invalid recovery entry; preserved')
      const key=e.stage+':'+e.code
      if(keys.has(key))throw new Error('Duplicate recovery entry; preserved');keys.add(key)
      const solutions:Entry['solutions']={}
      for(const [name,n]of Object.entries(e.solutions)){if(!Object.hasOwn(guides,name)||!count(n)||n===0)throw new Error('Invalid recovery solution; preserved');solutions[name as RecoverySolution]=n}
      if(e.status==='resolved'&&!Object.keys(solutions).length)throw new Error('Unverified resolution; preserved')
      if(e.lastOperationId!==undefined&&!operation(e.lastOperationId)||e.lastResolvedOperationId!==undefined&&!operation(e.lastResolvedOperationId))throw new Error('Invalid recovery association; preserved')
      entries.push({stage:e.stage,code:e.code,status:e.status as Entry['status'],occurrences:e.occurrences,solutions,firstAt:e.firstAt,lastAt:e.lastAt,...(e.lastOperationId?{lastOperationId:e.lastOperationId as string}:{}),...(e.lastResolvedOperationId?{lastResolvedOperationId:e.lastResolvedOperationId as string}:{})})
    }
    return {version:1,scope,entries}
  }
  async note(scope:string,issue:FormatIssue,solution?:RecoverySolution,operationId?:string):Promise<void>{
    if(!hash(scope)||!stages.has(issue.stage)||!codes.has(issue.code)||solution!==undefined&&!Object.hasOwn(guides,solution)||operationId!==undefined&&!operation(operationId))throw new Error('Invalid recovery observation')
    await privateDirectory(this.directory)
    const release=await acquireLock(join(this.directory,scope+'.lock'),AbortSignal.timeout(1000))
    try{
      const memory=await this.read(scope),now=new Date().toISOString()
      let entry=memory.entries.find(e=>e.stage===issue.stage&&e.code===issue.code)
      if(!entry){entry={stage:issue.stage,code:issue.code,status:'pending',occurrences:0,solutions:{},firstAt:now,lastAt:now};memory.entries.push(entry)}
      entry.lastAt=now
      if(operationId)entry.lastOperationId=operationId
      if(solution){entry.solutions[solution]=(entry.solutions[solution]??0)+1;entry.status='resolved';entry.occurrences=Math.max(1,entry.occurrences);if(operationId)entry.lastResolvedOperationId=operationId}
      else {entry.occurrences++;entry.status='pending'}
      if(!count(entry.occurrences)||Object.values(entry.solutions).some(n=>!count(n)))throw new Error('Recovery counters exhausted')
      await writeJson(join(this.directory,scope+'.json'),memory)
    }finally{await release()}
  }
  async hints(scope:string):Promise<RecoverySolution[]>{
    const memory=await this.read(scope)
    return [...new Set(memory.entries.flatMap(e=>Object.keys(e.solutions) as RecoverySolution[]))].sort()
  }
  async all():Promise<Memory[]>{
    let names:string[]
    try{names=await readdir(this.directory)}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error}
    return Promise.all(names.filter(n=>/^[a-f0-9]{64}\.json$/.test(n)).sort().map(n=>this.read(n.slice(0,-5))))
  }
}
