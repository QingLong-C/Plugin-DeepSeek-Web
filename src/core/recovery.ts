import { canonical, decodeResponse, encodeFormatRepair, encodeProtocolCorrection, encodeToolCorrection, repeatedTaskCall, WebResponseFormatError } from './codec.js'
import { record, TokenFreeError, ToolArgumentsError } from './errors.js'
import { toolJson } from './json.js'
import { digest, type ActiveOperation } from '../local/store.js'
import type { Block, ModelInput } from './types.js'

type Repair = NonNullable<ActiveOperation['repair']>
type Validate = (text: string, id: string) => Block[]
interface Admission { summary: boolean; shown: boolean; attempted: boolean; confirmed: boolean }
interface Plan {
  prompt: string
  expected?: Block[]
  mode?: Repair['mode']
  invalidCalls?: number[]
  expectedKind?: 'tool' | 'final' | 'auto'
  candidateHash: string
  failure: { stage: string; code: string }
  logStage: string
}
const calls = (blocks: Block[]) => blocks.filter(block => block.type === 'tool-call')

/** One admission/budget boundary for all verified, undelivered response-validation failures. No execution here. */
export function planRecovery(error: unknown, raw: string, input: ModelInput, id: string, maxChars: number, validate: Validate, admission: Admission): Plan | undefined {
  const outputFailure = error instanceof TokenFreeError && ['INVALID_TOOL_CALL', 'TOOL_CHOICE', 'OUTPUT_FORMAT', 'OUTPUT_SCHEMA'].includes(error.code)
  if (!(error instanceof WebResponseFormatError) && !outputFailure) return
  if (admission.summary || admission.shown || !admission.confirmed) return
  if (admission.attempted) {
    if (error instanceof ToolArgumentsError) throw new ToolArgumentsError(`已自动纠正一次，参数仍不合格。${error.message}`, error.issue)
    throw new TokenFreeError('已自动纠正一次，返回协议或格式规则仍不合格；本步骤未执行工具。', error instanceof TokenFreeError ? error.code : 'WEB_TOOL_FORMAT')
  }
  const failure = { stage: error instanceof WebResponseFormatError ? error.stage : error.code === 'INVALID_TOOL_CALL' ? 'arguments' : error.code === 'TOOL_CHOICE' ? 'policy' : 'output', code: error.code }
  if (error instanceof ToolArgumentsError && error.code === 'INVALID_TOOL_CALL') {
    // A complete decoded batch exists; freeze its valid calls while the model fixes invalid arguments.
    const expected = decodeResponse(raw, input.tools), batch = calls(expected)
    const errors: (ToolArgumentsError['issue'] & { call: number; name: string })[] = []
    for (const [index, call] of batch.entries()) {
      try { validate(JSON.stringify({ protocol_version: 1, request_id: id, kind: 'tool', calls: [{ name: call.name, arguments: JSON.parse(call.arguments) }] }), id) }
      catch (issue) { if (!(issue instanceof ToolArgumentsError)) throw issue; errors.push({ ...issue.issue, call: index, name: call.name }) }
    }
    if (!errors.length) throw error
    return { prompt: encodeToolCorrection(input, id, batch, errors, maxChars), expected, mode: 'arguments', invalidCalls: errors.map(issue => issue.call),
      candidateHash: digest(canonical(expected)), failure, logStage: 'tool-arguments' }
  }
  if (error instanceof WebResponseFormatError && error.stage === 'wrapper') {
    // Only a fully valid original intent may use wrapper-only repair; other failures use fresh context.
    const value = toolJson(raw, undefined, true)
    if (!record(value)) throw error
    try {
      validate(JSON.stringify({ ...value, protocol_version: 1, request_id: id }), id)
      const expected = decodeResponse(raw, input.tools)
      return { prompt: encodeFormatRepair({ messages: [], tools: input.tools }, raw, maxChars, id), expected, candidateHash: digest(canonical(expected)), failure, logStage: 'response-wrapper' }
    } catch (issue) {
      if (!(issue instanceof WebResponseFormatError) && !(issue instanceof ToolArgumentsError)
        && !(issue instanceof TokenFreeError && ['TOOL_CHOICE', 'OUTPUT_FORMAT', 'OUTPUT_SCHEMA'].includes(issue.code))) throw issue
      // The complete wrapper candidate also fails policy/schema; never freeze it as a valid intent.
    }
  }
  const required = input.policy?.tools.mode === 'required' || input.policy?.tools.mode === 'named'
  const final = input.policy?.tools.mode === 'none' || !input.tools.length || failure.stage === 'output'
    || error instanceof WebResponseFormatError && error.intent === 'final'
  const expectedKind = required ? 'tool' : final ? 'final' : error instanceof WebResponseFormatError && error.intent === 'tool' ? 'tool' : 'auto'
  return { prompt: encodeProtocolCorrection(input, id, maxChars, expectedKind, { ...failure, reason: error.message }), mode: 'protocol', expectedKind,
    candidateHash: digest(raw), failure, logStage: expectedKind === 'tool' ? 'tool-protocol' : 'response-protocol' }
}

/** All strategies return through the same validated-result gate before native delivery. */
export function checkRecoveryResult(repair: Repair | undefined, expected: Block[] | undefined, input: ModelInput, blocks: Block[]): void {
  if (!repair) return
  const fail = (message: string): never => { throw new TokenFreeError(`已自动纠正一次，${message}；本步骤未执行工具。`, 'WEB_TOOL_FORMAT') }
  const actual = calls(blocks)
  if (repair.mode === 'protocol') {
    const kind = repair.expectedKind ?? 'tool' // Backward-compatible .8 journals.
    if (kind === 'tool' && !actual.length || kind === 'final' && actual.length || actual.length && blocks.some(block => block.type === 'text')
      || !actual.length && !blocks.some(block => block.type === 'text')) fail('纠正结果与所需工具/回答类型不符')
    if (repeatedTaskCall(input, blocks)) fail('返回了完全相同的已交付调用')
  } else if (repair.mode === 'arguments') {
    const before = calls(expected ?? [])
    if (!before.length || actual.length !== before.length || actual.some((call, index) => call.name !== before[index]!.name
      || !repair.invalidCalls?.includes(index) && canonical(JSON.parse(call.arguments)) !== canonical(JSON.parse(before[index]!.arguments)))) fail('改变了工具名称、顺序、数量或原本合格的调用')
  } else {
    const semantics = (items: Block[]) => items.map(block => block.type === 'tool-call' ? { type: block.type, name: block.name, arguments: block.arguments } : block)
    if (canonical(semantics(blocks)) !== canonical(semantics(expected ?? []))) fail('外壳修正改变了原本合法的调用或回答')
  }
}
