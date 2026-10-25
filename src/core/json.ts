/** JSON parser with duplicate-key detection at every object level. No coercion or candidate patching. */
export function strictJson(text: string): unknown {
  let i = 0
  const ws = () => { while (/[ \t\r\n]/.test(text[i] ?? '') && i < text.length) i++ }
  const string = () => {
    const start = i++
    let escape = false
    for (; i < text.length; i++) {
      const char = text[i]
      if (!escape && char === '"') return JSON.parse(text.slice(start, ++i)) as string
      if (!escape && char === '\\') escape = true
      else escape = false
    }
    throw new Error('Unterminated string')
  }
  const value = (depth: number): unknown => {
    if (depth > 64) throw new Error('JSON nesting exceeded limit')
    ws()
    if (text[i] === '"') return string()
    if (text[i] === '{') {
      i++; ws()
      const out: Record<string, unknown> = Object.create(null)
      if (text[i] === '}') { i++; return out }
      for (;;) {
        ws(); if (text[i] !== '"') throw new Error('Expected object key')
        const key = string(); ws()
        if (Object.hasOwn(out, key)) throw new Error('Duplicate JSON key')
        if (text[i++] !== ':') throw new Error('Expected colon')
        out[key] = value(depth + 1); ws()
        const separator = text[i++]
        if (separator === '}') return out
        if (separator !== ',') throw new Error('Expected object separator')
      }
    }
    if (text[i] === '[') {
      i++; ws(); const out: unknown[] = []
      if (text[i] === ']') { i++; return out }
      for (;;) {
        out.push(value(depth + 1)); ws()
        const separator = text[i++]
        if (separator === ']') return out
        if (separator !== ',') throw new Error('Expected array separator')
      }
    }
    const rest = text.slice(i)
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(rest)?.[0]
    if (!token) throw new Error('Invalid JSON value')
    i += token.length
    const parsed: unknown = JSON.parse(token)
    if (typeof parsed === 'number' && !Number.isFinite(parsed)) throw new Error('Invalid JSON number')
    return parsed
  }
  const result = value(0); ws()
  if (i !== text.length) throw new Error('Trailing JSON content')
  return result
}

/** Only a single whole-response fence is transport decoration; never extract from prose. */
export function unfence(text: string): string {
  return /^[ \t\r\n]*```(?:json|xml|dsml)?[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t\r\n]*$/i.exec(text)?.[1] ?? text
}

type JsonToken = { raw: string; kind: 'string' | 'scalar' | 'punctuation' }
const MAX_JSON = 2_621_440

/** Complete scalar tokens are immutable. Invalid escapes and truncated values are not repaired. */
function jsonTokens(source: string): JsonToken[] {
  const tokens: JsonToken[] = []
  let growth = 0
  for (let i = 0; i < source.length;) {
    const char = source[i]!
    if (/[ \t\r\n]/.test(char)) { i++; continue }
    if (tokens.length >= 8192) throw new Error('JSON grammar token budget exceeded')
    if ('{}[],:'.includes(char)) { tokens.push({ raw: char, kind: 'punctuation' }); i++; continue }
    if (char === '"') {
      const start = i++
      const parts: string[] = []
      let cursor = start, escape = false, closed = false
      for (; i < source.length; i++) {
        const c = source[i]!
        if (!escape && c.charCodeAt(0) < 32) {
          const encoded = JSON.stringify(c).slice(1, -1)
          parts.push(source.slice(cursor, i), encoded); cursor = i + 1
          growth += encoded.length - 1
          if (source.length + growth > MAX_JSON) throw new Error('Normalized tool JSON exceeds recovery limit')
        }
        if (!escape && c === '"') { i++; closed = true; break }
        if (!escape && c === '\\') escape = true
        else escape = false
      }
      if (!closed) throw new Error('Unterminated JSON string')
      parts.push(source.slice(cursor, i))
      const raw = parts.join('')
      JSON.parse(raw) // Reject bad escapes, including backslash followed by a raw control code.
      tokens.push({ raw, kind: 'string' }); continue
    }
    const start = i
    while (i < source.length && !/[ \t\r\n{}\[\],:"]/.test(source[i]!)) i++
    const raw = source.slice(start, i)
    if (!/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/.test(raw)) throw new Error('Invalid JSON scalar')
    const value: unknown = JSON.parse(raw)
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Invalid JSON number')
    tokens.push({ raw, kind: 'scalar' })
  }
  return tokens
}

type GrammarState = { index: number; stack: string; edits: [number, string][] }
type JsonContract = { meaning: (value: unknown) => string; terminal: (error: unknown) => boolean }

/** Shortest punctuation-only grammar repair. All equally cheap interpretations must agree.
 * No opening containers, keys, quotes or values are invented; work exhaustion rejects,
 * even when an earlier candidate looked usable. This is not constrained model decoding.
 */
function grammarJson(tokens: JsonToken[], contract?: JsonContract): unknown {
  if (!['{', '['].includes(tokens[0]?.raw ?? '')) throw new Error('Not a complete JSON container')
  const buckets: GrammarState[][] = Array.from({ length: 9 }, () => [])
  const seen = new Map<string, { cost: number; paths: Set<string> }>()
  let work = 0, queued = 0, result: unknown, identity: string | undefined, resultCost = 9
  let firstSyntax: unknown, firstSyntaxIdentity: string | undefined, multipleSyntax = false
  const put = (state: GrammarState, cost: number) => {
    if (cost > 8 || cost > resultCost || state.stack.length > 65) return
    const key = `${state.index}/${state.stack}`, path = JSON.stringify(state.edits)
    const previous = seen.get(key)
    if (previous && previous.cost < cost) return
    if (previous?.cost === cost) {
      if (previous.paths.has(path)) return
      if (previous.paths.size >= 16) throw new Error('JSON grammar ambiguity budget exceeded')
      previous.paths.add(path)
    } else seen.set(key, { cost, paths: new Set([path]) })
    if (++queued > 65_536) throw new Error('JSON grammar state budget exceeded')
    buckets[cost]!.push(state)
  }
  put({ index: 0, stack: 'v', edits: [] }, 0)
  for (let cost = 0; cost <= 8 && cost <= resultCost; cost++) {
    const bucket = buckets[cost]!
    for (let n = 0; n < bucket.length; n++) {
      if (++work > 65_536) throw new Error('JSON grammar work budget exceeded')
      const s = bucket[n]!, token = tokens[s.index], raw = token?.raw, top = s.stack.at(-1)!
      if (s.index === tokens.length && s.stack === 'd') {
        const pieces: string[] = []
        let edit = 0
        for (let i = 0; i <= tokens.length; i++) {
          let removed = false
          while (s.edits[edit]?.[0] === i) {
            const punctuation = s.edits[edit++]![1]
            if (punctuation === '') removed = true
            else pieces.push(punctuation)
          }
          if (i < tokens.length && !removed) pieces.push(tokens[i]!.raw)
        }
        const parsed = strictJson(pieces.join(' '))
        const syntaxIdentity = JSON.stringify(parsed)
        if (firstSyntaxIdentity === undefined) { firstSyntax = parsed; firstSyntaxIdentity = syntaxIdentity }
        else if (firstSyntaxIdentity !== syntaxIdentity) multipleSyntax = true
        resultCost = cost
        let key: string
        try { key = contract ? contract.meaning(parsed) : syntaxIdentity }
        catch (error) {
          if (contract?.terminal(error)) throw error // Identity and other authoritative guards cannot become syntax retries.
          continue // The complete original contract may rule out a structurally possible interpretation.
        }
        if (identity !== undefined && identity !== key) throw new Error('Ambiguous JSON structure; model correction required')
        result = parsed; identity = key; resultCost = cost; continue
      }
      const replace = (next: string) => s.stack.slice(0, -1) + next
      const value = token && (token.kind !== 'punctuation' || raw === '{' || raw === '[')
      let stack: string | undefined
      if (top === 'v' || top === 'A' || top === 'a') {
        if (value) {
          stack = replace(s.stack.length === 1 ? 'd' : top === 'v' ? 'o' : 'r')
          if (raw === '{' || raw === '[') stack += raw === '{' ? 'K' : 'A'
        } else if (top === 'A' && raw === ']') stack = s.stack.slice(0, -1)
      } else if ((top === 'K' || top === 'k') && token?.kind === 'string') stack = replace(':')
      else if (top === 'K' && raw === '}') stack = s.stack.slice(0, -1)
      else if (top === ':' && raw === ':') stack = replace('v')
      else if ((top === 'o' && raw === '}') || (top === 'r' && raw === ']')) stack = s.stack.slice(0, -1)
      else if ((top === 'o' || top === 'r') && raw === ',') stack = replace(top === 'o' ? 'k' : 'a')
      if (stack !== undefined) put({ ...s, index: s.index + 1, stack }, cost)
      const insert = (punctuation: string, next: string) => put({ index: s.index, stack: next, edits: [...s.edits, [s.index, punctuation]] }, cost + 1)
      if (top === ':' && value) insert(':', replace('v'))
      if ((top === 'o' && token?.kind === 'string') || (top === 'r' && value)) insert(',', replace(top === 'o' ? 'k' : 'a'))
      if ((top === 'o' || top === 'r') && (raw === undefined || [',', '}', ']'].includes(raw))) insert(top === 'o' ? '}' : ']', s.stack.slice(0, -1))
      // Only redundant copies of the root close are removable; internal delimiters
      // and mismatched types may carry structure and cannot simply be discarded.
      if (top === 'd' && raw === (tokens[0]!.raw === '{' ? '}' : ']')) put({ ...s, index: s.index + 1, edits: [...s.edits, [s.index, '']] }, cost + 1)
    }
  }
  // A unique syntactic result must still reach the normal decoder, so its real
  // identity/schema error retains its type and enters the existing recovery planner.
  if (identity === undefined && firstSyntaxIdentity !== undefined && !multipleSyntax) return firstSyntax
  if (identity === undefined) throw new Error('No unambiguous JSON grammar repair within budget')
  return result
}

/** Recover lexical encoding then grammar, shared by envelopes, DSML arguments and corrections. */
export function toolJson(text: string, recovered?: () => void, envelopeFraming = false, contract?: JsonContract): unknown {
  try { return strictJson(text) } catch (error) {
    if (error instanceof Error && /Duplicate|nesting|number/.test(error.message)) throw error
  }
  if (text.length > MAX_JSON) throw new Error('Tool JSON exceeds recovery limit')
  let source = unfence(text).trim()
  if (envelopeFraming) {
    let framing = 0
    while (source && '<>()'.includes(source[0]!)) { source = source.slice(1).trimStart(); framing++ }
    while (source && '<>()'.includes(source.at(-1)!)) { source = source.slice(0, -1).trimEnd(); framing++ }
    if (framing > 8) throw new Error('Too much envelope framing')
  }
  const tokens = jsonTokens(source)
  let commas = 0
  const normalized = tokens.filter((token, i) => {
    if (token.raw === ',' && ['}', ']'].includes(tokens[i + 1]?.raw ?? '')) {
      if (++commas > 32) throw new Error('Too many JSON syntax repairs')
      return false
    }
    return true
  })
  let parsed: unknown
  try { parsed = strictJson(normalized.map(t => t.raw).join(' ')) }
  catch (error) {
    if (error instanceof Error && /Duplicate|nesting|number/.test(error.message)) throw error
    parsed = grammarJson(normalized, contract)
  }
  recovered?.(); return parsed
}
