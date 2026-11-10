import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveCredential, readCredential, normalizeCredential } from '../lib/local/auth.js'
import { WebResponseState, readWebResponse } from '../lib/deepseek-web/sse.js'
import { encodeRequest, decodeResponse, encodeFormatRepair, responseShape, WebResponseFormatError } from '../lib/core/codec.js'
import { DeepSeekWebClient } from '../lib/deepseek-web/client.js'

const tool = { name: 'read_marker', description: 'Read a local marker.', parameters: { type: 'object', properties: {}, additionalProperties: false } }
const snapshot = (text, status = 'FINISHED') => ({ v: { response: { status, fragments: [{ type: 'THINK', content: 'private thought' }, { type: 'RESPONSE', content: text }] } } })
const sse = frames => new Response(frames.map(f => `data: ${JSON.stringify(f)}\r\n\r\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
const envelope = data => Response.json({ code: 0, data: { biz_code: 0, biz_data: data } })

test('single account file is private, replaceable, and refuses public permissions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tokenfree-auth-'))
  const file = join(dir, 'credentials.json')
  try {
    assert.equal(await readCredential(file), undefined)
    await saveCredential({ token: 'Bearer web-one' }, file)
    assert.equal((await stat(file)).mode & 0o777, 0o600)
    assert.equal((await readCredential(file)).token, 'web-one')
    await saveCredential({ token: 'web-two' }, file)
    assert.equal((await readCredential(file)).token, 'web-two')
    assert.equal((await readFile(file, 'utf8')).includes('web-one'), false)
    await chmod(file, 0o644)
    await assert.rejects(readCredential(file), /permissions/)
    assert.throws(() => normalizeCredential([{ token: 'not-a-pool' }]), /single/)
    assert.throws(() => normalizeCredential({ token: 'secret\nheader' }), error => !error.message.includes('secret'))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('Web SSE decodes snapshots, compressed appends, and relative batches without leaking thinking', async () => {
  const frames = [snapshot('你', 'WIP'), { p: 'response', o: 'BATCH', v: [
    { p: 'fragments/-1/content', o: 'APPEND', v: '好' }, { v: '！' }, { p: 'status', o: 'SET', v: 'FINISHED' },
  ] }]
  const bytes = new TextEncoder().encode(frames.map(f => `data: ${JSON.stringify(f)}\r\n\r\n`).join(''))
  let offset = 0
  const response = new Response(new ReadableStream({ pull(controller) {
    if (offset === bytes.length) return controller.close()
    controller.enqueue(bytes.slice(offset, ++offset))
  } }), { headers: { 'content-type': 'text/event-stream' } })
  assert.equal(await readWebResponse(response), '你好！')
})

test('disconnect, invalid JSON, failed completion and forbidden patch paths fail closed', async () => {
  await assert.rejects(readWebResponse(sse([snapshot('{"kind":"tool"}', 'WIP')])), /disconnected/)
  await assert.rejects(readWebResponse(sse([snapshot('filtered', 'CONTENT_FILTER')])), error => {
    assert.equal(error.code, 'CONTENT_RETRACTED')
    assert.match(error.message, /官网内容过滤.*CONTENT_FILTER/)
    return true
  })
  await assert.rejects(readWebResponse(new Response('data: bad-json\n\n', { headers: { 'content-type': 'text/event-stream' } })), /Invalid JSON/)
  const state = new WebResponseState()
  assert.throws(() => state.apply({ p: '__proto__/polluted', v: true }), /patch path/)
  assert.equal({}.polluted, undefined)
})

test('prompt retains system, ordered tool history and real call IDs; never truncates', () => {
  const options = { provider: 'p', model: 'm', system: 'system-exact', tools: [tool], messages: [
    { role: 'user', content: [{ type: 'text', text: 'question' }] },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'call-1', name: 'read_marker', arguments: '{}' }] },
    { role: 'tool', source: { kind: 'tool', callId: 'call-1' }, content: [{ type: 'text', text: 'actual-marker' }] },
  ] }
  const encoded = encodeRequest(options, 20000)
  const payload = JSON.parse(encoded.split('DSH_INPUT_JSON:\n')[1].split('\n\nDSH_RESPONSE_CONTRACT:\n')[0])
  assert.equal(payload.system, 'system-exact')
  assert.equal(payload.messages[2].callId, 'call-1')
  assert.equal(payload.messages[2].content[0].text, 'actual-marker')
  assert.deepEqual(payload.tools, [tool])
  assert.equal(payload.protocol_version, 1)
  assert.equal(payload.mode, 'bootstrap')
  assert.throws(() => encodeRequest(options, 20), /exceeds/)
})

test('format correction preserves full request context, treats candidate as data and refuses oversize input', () => {
  const options = { provider: 'p', model: 'm', system: 'exact-system', tools: [tool], messages: [{ role: 'user', content: [{ type: 'text', text: 'exact-question' }] }] }
  const candidate = '{"kind":"final","text":"exact answer"}'
  const prompt = encodeFormatRepair(options, candidate, 20000, 'fixture-id')
  assert.match(prompt, /FORMAT_REPAIR fixture-id/)
  assert.equal(prompt.split('CANDIDATE_JSON:\n')[1], candidate)
  assert.throws(() => encodeFormatRepair(options, candidate, 10), error => error.code === 'INPUT_TOO_LARGE')
  assert.equal(responseShape('```json\n{}\n```'), 'fenced')
  assert.equal(responseShape('<tool_call>fixture</tool_call>'), 'tagged')
  assert.equal(responseShape('hello'), 'plain-text')
  assert.equal(responseShape('{}'), 'json-object')
  assert.throws(() => decodeResponse('hello', [tool]), error => error instanceof WebResponseFormatError && ['syntax', 'tool'].includes(error.stage))
  assert.throws(() => decodeResponse('{"kind":"tool","calls":[{"name":"unregistered","arguments":{}}]}', [tool]), error => error instanceof WebResponseFormatError && ['syntax', 'tool'].includes(error.stage))
})

test('only complete valid batches of declared tool calls become executable', () => {
  const blocks = decodeResponse('{"kind":"tool","calls":[{"name":"read_marker","arguments":{}}]}', [tool])
  assert.equal(blocks[0].type, 'tool-call')
  assert.equal(blocks[0].name, 'read_marker')
  assert.equal(blocks[0].arguments, '{}')
  assert.match(blocks[0].id, /^tokenfree_/)
  assert.throws(() => decodeResponse('{"kind":"tool","calls":[{"name":"read_marker","arguments":{}},{"name":"shell","arguments":{}}]}', [tool]), /Unknown tool/)
  assert.throws(() => decodeResponse('example: {"kind":"tool"}', [tool]), error => error.code === 'WEB_TOOL_FORMAT')
  assert.throws(() => decodeResponse('{"kind":"tool","calls":[{"name":"read_marker","arguments":"bad"}]}', [tool]), /arguments/)
  assert.deepEqual(decodeResponse('{"kind":"final","text":"A quoted tool call is only text."}', [tool]), [{ type: 'text', text: 'A quoted tool call is only text.' }])
})

test('client sends only Web credential to official Web origin, with DSH attribution and no redirects', async () => {
  const requests = []
  const client = new DeepSeekWebClient({ token: 'fixture-web-token' }, {
    headers: { 'user-agent': 'fixture-attribution' }, fetch: async (url, options) => {
      requests.push({ url, options })
      if (url.endsWith('/chat_session/create')) return envelope({ chat_session: { id: 'owned-session' } })
      if (url.endsWith('/create_pow_challenge')) return envelope({ challenge: { algorithm: 'DeepSeekHashV1', challenge: 'fixture', salt: 'salt', signature: 'signature', difficulty: 1, expire_at: 123 } })
      if (url.endsWith('/chat/completion')) return sse([snapshot('answer')])
      throw new Error('Unexpected endpoint')
    }, solve: async () => 'fixture-proof',
  })
  assert.equal(await client.complete('prompt-exact', AbortSignal.timeout(1000)), 'answer')
  assert.equal(requests.length, 3)
  for (const { url, options } of requests) {
    assert.equal(new URL(url).origin, 'https://chat.deepseek.com')
    assert.equal(options.redirect, 'error')
    assert.equal(options.headers.authorization, 'Bearer fixture-web-token')
      assert.equal(options.headers['user-agent'], 'fixture-attribution')
    assert.equal(options.headers['x-api-key'], undefined)
    assert.equal(options.headers['x-dsh-auth-token'], undefined)
  }
  const payload = JSON.parse(requests[2].options.body)
  assert.equal(payload.prompt, 'prompt-exact')
  assert.equal(payload.parent_message_id, null)
  assert.equal(payload.model_type, null)
  assert.equal(payload.thinking_enabled, false)
  assert.equal(payload.search_enabled, false)
})

test('authentication, rate limits, redirects, and raw upstream errors never trigger another account or API', async () => {
  for (const status of [401, 403, 429, 402]) {
    let calls = 0
    const client = new DeepSeekWebClient({ token: 'fixture-secret' }, { fetch: async () => { calls++; return new Response('fixture-secret', { status }) } })
    await assert.rejects(client.complete('hello', AbortSignal.timeout(1000)), error => !error.message.includes('fixture-secret'))
    assert.equal(calls, 1)
  }
})

test('transient read-only GET transport failures retry at most twice, while POSTs are never replayed', async () => {
  const transportFailure = () => Object.assign(new TypeError('fixture fetch failed'), { cause: { code: 'ECONNRESET' } })
  let reads = 0
  const recovering = new DeepSeekWebClient({ token: 'fixture-token' }, { fetch: async () => {
    if (++reads === 1) throw transportFailure()
    return envelope({ cache_control: 'REPLACE', chat_messages: [] })
  } })
  assert.deepEqual(await recovering.history('fixture-chat', AbortSignal.timeout(5000)), [])
  assert.equal(reads, 2)

  let failedReads = 0
  const disconnected = new DeepSeekWebClient({ token: 'fixture-token' }, { fetch: async () => {
    failedReads++
    throw transportFailure()
  } })
  await assert.rejects(disconnected.history('fixture-chat', AbortSignal.timeout(5000)), error => error.code === 'TRANSPORT')
  assert.equal(failedReads, 3)

  let writes = 0
  const post = new DeepSeekWebClient({ token: 'fixture-token' }, { fetch: async () => {
    writes++
    throw transportFailure()
  } })
  await assert.rejects(post.complete('hello', AbortSignal.timeout(1000)), error => error.code === 'TRANSPORT')
  assert.equal(writes, 1)
})

test('official top-level authentication rejection survives an absent metadata data envelope', async () => {
  for (const code of [40001, 40002, 40003]) {
    for (const fields of [{ data: null }, {}, { data: 'not-an-envelope' }]) {
      let requests = 0
      const client = new DeepSeekWebClient({ token: 'fixture-private-token' }, {
        fetch: async () => {
          requests++
          return Response.json({ code, msg: 'fixture-private-upstream-message', ...fields })
        },
      })
      await assert.rejects(client.check(AbortSignal.timeout(1000)), error => {
        assert.equal(error.code, 'AUTH')
        assert.equal(error.message.includes('fixture-private'), false)
        return true
      })
      assert.equal(requests, 1)
    }
  }
})

test('metadata authentication classification retains business errors and rejects malformed success', async () => {
  for (const [body, expected] of [
    [{ code: 0, data: { biz_code: 40003, biz_data: null } }, 'AUTH'],
    [{ code: 0, data: null }, 'WEB_PROTOCOL'],
    [{ code: 49999, data: null }, 'WEB_PROTOCOL'],
    [null, 'WEB_PROTOCOL'],
  ]) {
    const client = new DeepSeekWebClient({ token: 'fixture-token' }, {
      fetch: async () => Response.json(body),
    })
    await assert.rejects(client.check(AbortSignal.timeout(1000)), error => error.code === expected)
  }
})

test('generation JSON refusals retain safe error classes without pretending to be an SSE stream', async () => {
  for (const mode of ['generate', 'editRoot']) for (const [response, code, rejected, numeric] of [
    [() => Response.json({ code: 40003, msg: 'fixture-private-reflection' }), 'AUTH', true, { code: 40003 }],
    [() => Response.json({ code: 0, data: { biz_code: 40003 } }), 'AUTH', true, { code: 0, bizCode: 40003 }],
    [() => Response.json({ code: 0, data: { biz_code: 40301 } }), 'POW_FAILED', true, { code: 0, bizCode: 40301 }],
    [() => Response.json({ code: 0, data: { biz_code: 40029 } }), 'WEB_CHALLENGE', false, { code: 0, bizCode: 40029 }],
    [() => Response.json({ code: 0, data: { biz_code: 49999, biz_msg: 'fixture-private-reflection' } }), 'WEB_REJECTED', false, { code: 0, bizCode: 49999 }],
    [() => Response.json({ code: 0, data: { biz_code: 0, biz_data: {} } }), 'WEB_PROTOCOL', false, { code: 0, bizCode: 0 }],
    [() => new Response('<html>fixture-private-reflection</html>', { headers: { 'content-type': 'text/html' } }), 'WEB_PROTOCOL', false],
    [() => new Response('{fixture-private-reflection', { headers: { 'content-type': 'application/json' } }), 'WEB_PROTOCOL', false],
  ]) {
    let completions = 0
    const diagnostics = []
    const client = new DeepSeekWebClient({ token: 'fixture-token' }, {
      operationId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      diagnostics: { protect() {}, write() {}, content(_id, event, payload) { if (event === 'web.envelope') diagnostics.push(payload) } },
      solve: async () => 'fixture-proof',
      fetch: async url => {
        if (url.endsWith('create_pow_challenge')) return envelope({ challenge: {
          algorithm: 'DeepSeekHashV1', challenge: 'fixture', salt: 'fixture', signature: 'fixture', difficulty: 1, expire_at: Date.now() + 60000,
        } })
        assert.equal(new URL(url).pathname, mode === 'generate' ? '/api/v0/chat/completion' : '/api/v0/chat/edit_message')
        completions++; return response()
      },
    })
    const consume = async () => { for await (const event of client[mode]('fixture-chat', mode === 'generate' ? null : 1, 'hello', false, AbortSignal.timeout(1000))) assert.fail('No event may be delivered') }
    await assert.rejects(consume(), error => error.code === code && Boolean(error.details?.accepted === false) === rejected && !error.message.includes('fixture-private'))
    assert.equal(completions, 1)
    if (numeric) assert.deepEqual(diagnostics.at(-1), numeric)
    assert.equal(JSON.stringify(diagnostics).includes('fixture-private-reflection'), false)
  }
})
