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

/** Recover punctuation and string encoding only; decoded keys and scalar values never change. */
export function toolJson(text: string, recovered?: () => void, envelopeFraming = false): unknown {
  try { return strictJson(text) } catch { /* Try one bounded local normalization. */ }
  if (text.length > 2_621_440) throw new Error('Tool JSON exceeds recovery limit')
  const source = unfence(text)
  try {
    const value = strictJson(source)
    recovered?.(); return value
  } catch { /* The candidate still needs punctuation normalization. */ }
  const stack: string[] = [], removed = new Set<number>(), encoded = new Map<number, string>()
  let quoted = false, escape = false, started = false, rootClose = '', extras = 0, framing = 0, encodingGrowth = 0
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!
    if (quoted) {
      // A literal control code has one JSON encoding and the same decoded value.
      // Do not reinterpret a backslash followed by a raw newline or another bad escape.
      if (!escape && char.charCodeAt(0) < 32) {
        const replacement = JSON.stringify(char).slice(1, -1)
        encodingGrowth += replacement.length - 1
        if (source.length + encodingGrowth > 2_621_440) throw new Error('Normalized tool JSON exceeds recovery limit')
        encoded.set(i, replacement)
      }
      if (!escape && char === '"') quoted = false
      if (!escape && char === '\\') escape = true
      else escape = false
      continue
    }
    if (/\s/.test(char)) continue
    // Envelope-only transport punctuation outside a single root. Never search prose,
    // strip XML tags, modify a JSON value, or apply this rule to argument strings.
    if (envelopeFraming && (!started || !stack.length) && '<>()'.includes(char)) {
      if (++framing > 8 || removed.size >= 32) throw new Error('Too much envelope framing')
      removed.add(i); continue
    }
    if (!started) {
      if (char !== '{' && char !== '[') throw new Error('Not a complete JSON container')
      started = true; rootClose = char === '{' ? '}' : ']'
    } else if (!stack.length) {
      if (char !== rootClose || ++extras > 8) throw new Error('Extra JSON data')
      removed.add(i)
      if (removed.size > 32) throw new Error('Too many JSON syntax repairs')
      continue
    }
    if (char === '"') { quoted = true; continue }
    if (char === '{' || char === '[') {
      if (stack.length >= 64) throw new Error('JSON nesting exceeded limit')
      stack.push(char === '{' ? '}' : ']')
    } else if (char === '}' || char === ']') {
      if (stack.pop() !== char) throw new Error('Mismatched JSON delimiter')
    } else if (char === ',') {
      let next = i + 1
      while (next < source.length && /\s/.test(source[next]!)) next++
      if (source[next] === '}' || source[next] === ']') removed.add(i)
    }
    if (removed.size > 32) throw new Error('Too many JSON syntax repairs')
  }
  if (!started || quoted || stack.length > 8) throw new Error('Incomplete JSON value')
  const pieces: string[] = []
  let cursor = 0
  for (const index of [...removed, ...encoded.keys()].sort((a, b) => a - b)) {
    pieces.push(source.slice(cursor, index), encoded.get(index) ?? ''); cursor = index + 1
  }
  pieces.push(source.slice(cursor), ...stack.reverse())
  const candidate = pieces.join('')
  if (candidate.length > 2_621_440) throw new Error('Normalized tool JSON exceeds recovery limit')
  if (candidate === text) throw new Error('No supported JSON syntax repair')
  const value = strictJson(candidate) // duplicate keys, missing values and invalid tokens still reject the whole batch
  recovered?.()
  return value
}
