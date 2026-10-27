import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { TokenFreeAdapter, PROVIDER, MODEL } from '../lib/dsh/adapter.js'
import { setup, collect, envelope, user } from './helpers/fixture.mjs'

const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII=', 'base64')
const ref = { attachmentId: createHash('sha256').update(bytes).digest('hex'), mediaType: 'image/png', bytes: bytes.length, width: 1, height: 1, name: 'one.png' }
const picture = () => ({ id: 'image-question', role: 'user', content: [{ type: 'text', text: 'Describe this image.' }, { type: 'image', attachment: ref }] })
const options = (messages = [picture()], sessionId) => ({ provider: PROVIDER, model: MODEL, messages, ...(sessionId ? { sessionId } : {}) })

function imageServer(f) {
  const baseFetch = f.web.fetch
  const wire = { uploads: [], polls: [], files: new Map(), failUpload: undefined, status: 'SUCCESS' }
  f.web.fetch = async (url, init) => {
    const path = new URL(url).pathname
    if (path.endsWith('/file/upload_file')) {
      wire.uploads.push(init)
      if (wire.failUpload) return wire.failUpload(init)
      const id = `file-test-${wire.uploads.length}`
      const file = { id, status: wire.status, error_code: null }
      wire.files.set(id, file)
      return envelope(file)
    }
    if (path.endsWith('/file/fetch_files')) {
      const ids = new URL(url).searchParams.get('file_ids').split(',')
      wire.polls.push(ids)
      return envelope({ files: ids.map(id => wire.files.get(id)).filter(Boolean) })
    }
    const response = await baseFetch(url, init)
    if (path.endsWith('/completion') || path.endsWith('/edit_message')) {
      const body = JSON.parse(init.body)
      const messages = f.web.chats.get(body.chat_session_id)
      const request = messages.at(-2)
      if (body.ref_file_ids.length) request.fragments.unshift({ type: 'FILE', files: body.ref_file_ids.map(id => ({ id, status: 'SUCCESS' })) })
    }
    return response
  }
  return wire
}
const adapterFor = (f, extra = {}) => new TokenFreeAdapter({}, {
  store: f.store, native: f.native, credential: async () => ({ token: 'fixture-secret-token', accountId: 'fixture-owner' }),
  client: () => f.web.client(), readImage: async () => bytes, ...extra,
})

test('image input reaches official multipart upload and the exact referenced generation', async () => {
  const f = await setup(), wire = imageServer(f), adapter = adapterFor(f)
  try {
    const chunks = await collect(adapter.stream(options()))
    assert.equal(chunks.at(-1).type, 'finish')
    assert.equal(wire.uploads.length, 1)
    const upload = wire.uploads[0]
    assert(upload.body instanceof FormData)
    assert.deepEqual(Buffer.from(await upload.body.get('file').arrayBuffer()), bytes)
    assert.equal(upload.headers['content-type'], undefined, 'FormData owns its boundary')
    assert.equal(upload.headers.authorization, 'Bearer fixture-secret-token')
    assert.equal(upload.headers['x-file-size'], String(bytes.length))
    assert.deepEqual(f.web.generations[0].ref_file_ids, ['file-test-1'])
    assert(f.web.generations[0].prompt.includes('file-test-1'))
    assert(!f.web.generations[0].prompt.includes(bytes.toString('base64')))
  } finally { await adapter.dispose(); await f.close() }
})

test('image-capable catalogue preserves the existing model name and route', async () => {
  const f = await setup(), adapter = adapterFor(f)
  try {
    const listed = (await adapter.listModels(PROVIDER))[0]
    const resolved = await adapter.resolveModel(PROVIDER, MODEL)
    for (const m of [listed, resolved]) { assert.equal(m.name, 'DeepSeek Web'); assert.deepEqual(m.inputModalities, ['text', 'image']) }
  } finally { await adapter.dispose(); await f.close() }
})

test('confirmed image history is retained without uploading or attaching it on every tool or user step', async () => {
  const f = await setup(), wire = imageServer(f), adapter = adapterFor(f)
  try {
    f.native.begin()
    await collect(adapter.stream(options([picture()], 'session-1')))
    const pending = (await (await adapter.engine()).inspect('session-1')).pending
    const reply = f.native.save({ blocks: pending.expected, operation: pending })
    await adapter.reconcile('session-1')
    f.native.begin()
    await collect(adapter.stream(options([picture(), reply, user('And its colour?', 'follow-up')], 'session-1')))
    assert.equal(wire.uploads.length, 1)
    assert.deepEqual(f.web.generations.map(g => g.ref_file_ids), [['file-test-1'], []])
    assert.equal(f.web.chats.size, 1)
  } finally { await adapter.dispose(); await f.close() }
})

test('offloaded images stay text placeholders and are never uploaded', async () => {
  const f = await setup(), wire = imageServer(f), adapter = adapterFor(f)
  try {
    const m = picture(); m.content[1].offloaded = true
    await collect(adapter.stream(options([m])))
    assert.equal(wire.uploads.length, 0)
    assert.deepEqual(f.web.generations[0].ref_file_ids, [])
    assert(f.web.generations[0].prompt.includes('offloaded'))
  } finally { await adapter.dispose(); await f.close() }
})

test('image compaction reuses the account file on the summary branch and preserves the original branch', async () => {
  const f = await setup(), wire = imageServer(f), adapter = adapterFor(f)
  try {
    f.native.begin()
    await collect(adapter.stream(options([picture()], 'session-1')))
    const pending = (await (await adapter.engine()).inspect('session-1')).pending
    const reply = f.native.save({ blocks: pending.expected, operation: pending })
    await adapter.reconcile('session-1')
    const original = structuredClone(f.web.chats.get('chat-1'))
    const chunks = await adapter.withCompaction({ sessionId: 'session-1', compactionId: 'image-summary', startSeq: 1, thinking: true },
      signal => collect(adapter.stream({ ...options([picture(), reply], 'session-1'), purpose: 'compaction', signal })))
    assert.equal(chunks.at(-1).type, 'finish')
    assert.equal(wire.uploads.length, 1)
    assert.equal(f.web.edits.length, 1)
    assert.deepEqual(f.web.edits[0].ref_file_ids, ['file-test-1'])
    assert(f.web.edits[0].prompt.includes('file-test-1'))
    assert.deepEqual(f.web.chats.get('chat-1').slice(0, original.length), original)
  } finally { await adapter.dispose(); await f.close() }
})

test('a different account cannot reuse another account image journal', async () => {
  const f = await setup(), wire = imageServer(f)
  const first = adapterFor(f)
  let second
  try {
    await collect(first.stream(options()))
    await first.dispose()
    second = adapterFor(f, { credential: async () => ({ token: 'fixture-other-token', accountId: 'fixture-other-owner' }) })
    await collect(second.stream(options()))
    assert.equal(wire.uploads.length, 2)
    assert.deepEqual(f.web.generations.map(g => g.ref_file_ids), [['file-test-1'], ['file-test-2']])
    assert.equal((await readdir(join(f.home, 'image-uploads'))).length, 2)
  } finally { await second?.dispose(); await first.dispose(); await f.close() }
})

test('cold adapter and rebuilt web chats reuse the verified account upload', async () => {
  const f = await setup(), wire = imageServer(f)
  let adapter = adapterFor(f)
  try {
    await collect(adapter.stream(options()))
    await adapter.dispose(); adapter = adapterFor(f)
    await collect(adapter.stream(options()))
    assert.equal(wire.uploads.length, 1)
    assert.deepEqual(f.web.generations.map(g => g.ref_file_ids), [['file-test-1'], ['file-test-1']])
    assert.equal(f.web.chats.size, 2)
  } finally { await adapter.dispose(); await f.close() }
})

test('format repair keeps the accepted image in its ancestor and does not upload or reattach it', async () => {
  const f = await setup(), wire = imageServer(f), adapter = adapterFor(f)
  f.web.answer = (p, _, n) => n === 1 ? 'broken response' : ({ protocol_version: 1, request_id: p.request_id, kind: 'final', text: 'repaired' })
  try {
    await collect(adapter.stream(options()))
    assert.equal(wire.uploads.length, 1)
    assert.deepEqual(f.web.generations.map(g => g.ref_file_ids), [['file-test-1'], []])
  } finally { await adapter.dispose(); await f.close() }
})

test('ambiguous upload is journaled and never automatically submitted a second time', async () => {
  const f = await setup(), wire = imageServer(f), adapter = adapterFor(f)
  wire.failUpload = () => { throw new Error('fixture disconnected after accepting bytes') }
  try {
    await assert.rejects(() => collect(adapter.stream(options())), e => e.code === 'TRANSPORT')
    await assert.rejects(() => collect(adapter.stream(options())), e => e.code === 'IMAGE_UPLOAD_UNCERTAIN')
    assert.equal(wire.uploads.length, 1)
    assert.equal(f.web.generations.length, 0)
  } finally { await adapter.dispose(); await f.close() }
})

test('explicit upload rate refusal updates shared cooldown and sends no generation', async () => {
  const f = await setup(), wire = imageServer(f), adapter = adapterFor(f)
  wire.failUpload = () => new Response('', { status: 429, headers: { 'retry-after': '1' } })
  try {
    await assert.rejects(() => collect(adapter.stream(options())), e => e.code === 'RATE_LIMIT')
    assert.equal(wire.uploads.length, 1)
    assert.equal(f.web.generations.length, 0)
    const state = JSON.parse(await readFile(join(f.home, 'requests', f.accountKey + '.json'), 'utf8'))
    assert.equal(state.strikes, 1); assert(state.until > Date.now())
  } finally { await adapter.dispose(); await f.close() }
})

test('upload preparation refusal is known unsubmitted and can be retried manually', async () => {
  const f = await setup(), wire = imageServer(f), adapter = adapterFor(f)
  f.web.preparing = () => new Response('', { status: 403 })
  try {
    await assert.rejects(() => collect(adapter.stream(options())), e => e.code === 'WEB_CHALLENGE')
    f.web.preparing = undefined
    await collect(adapter.stream(options()))
    assert.equal(wire.uploads.length, 1)
    assert.equal(f.web.generations.length, 1)
  } finally { await adapter.dispose(); await f.close() }
})

test('bad image bytes fail before uploads, chat creation and generation', async () => {
  const f = await setup(), wire = imageServer(f), adapter = adapterFor(f, { readImage: async () => new Uint8Array(bytes.length) })
  try {
    await assert.rejects(() => collect(adapter.stream(options())), e => e.code === 'IMAGE_INPUT')
    assert.equal(wire.uploads.length, 0); assert.equal(f.web.chats.size, 0)
  } finally { await adapter.dispose(); await f.close() }
})

test('failed official image processing does not generate or keep uploading on retry', async () => {
  const f = await setup(), wire = imageServer(f), adapter = adapterFor(f)
  wire.status = 'FAILED'
  try {
    for (let i = 0; i < 2; i++) await assert.rejects(() => collect(adapter.stream(options())), e => e.code === 'IMAGE_REJECTED')
    assert.equal(wire.uploads.length, 1); assert.equal(f.web.generations.length, 0)
  } finally { await adapter.dispose(); await f.close() }
})

test('cancelling pending processing keeps the file id for a later manual retry', async () => {
  const f = await setup(), wire = imageServer(f), adapter = adapterFor(f)
  const controller = new AbortController()
  wire.status = 'PENDING'
  const timer = setInterval(() => { if (wire.polls.length) controller.abort() }, 5)
  try {
    await assert.rejects(() => collect(adapter.stream({ ...options(), signal: controller.signal })), e => e.code === 'ABORTED')
    clearInterval(timer)
    wire.files.get('file-test-1').status = 'SUCCESS'
    await collect(adapter.stream(options()))
    assert.equal(wire.uploads.length, 1); assert.equal(f.web.generations.length, 1)
  } finally { clearInterval(timer); await adapter.dispose(); await f.close() }
})

test('attachment history changes cannot be delivered as a validated answer', async () => {
  const f = await setup(), wire = imageServer(f), adapter = adapterFor(f)
  f.web.historyHook = id => { for (const m of f.web.chats.get(id)) for (const fragment of m.fragments) if (fragment.type === 'FILE') fragment.files = [{ id: 'file-other' }] }
  try {
    await assert.rejects(() => collect(adapter.stream(options())), e => e.code === 'WEB_IDENTITY')
    assert.equal(wire.uploads.length, 1); assert.equal(f.web.generations.length, 1)
  } finally { await adapter.dispose(); await f.close() }
})

test('corrupt image state is preserved instead of falling back to another upload', async () => {
  const f = await setup(), wire = imageServer(f), adapter = adapterFor(f)
  try {
    await collect(adapter.stream(options()))
    const directory = join(f.home, 'image-uploads', f.accountKey)
    const file = join(directory, (await readdir(directory))[0])
    await writeFile(file, '{broken')
    await assert.rejects(() => collect(adapter.stream(options())), e => e.code === 'STATE_STORAGE')
    assert.equal(wire.uploads.length, 1); assert.equal(await readFile(file, 'utf8'), '{broken')
  } finally { await adapter.dispose(); await f.close() }
})

test('missing cached official files pause rather than causing another upload', async () => {
  const f = await setup(), wire = imageServer(f), adapter = adapterFor(f)
  try {
    await collect(adapter.stream(options()))
    wire.files.clear()
    await assert.rejects(() => collect(adapter.stream(options())), e => e.code === 'IMAGE_NOT_READY')
    assert.equal(wire.uploads.length, 1)
    assert.equal(f.web.generations.length, 1)
  } finally { await adapter.dispose(); await f.close() }
})

test('too many retained occurrences request host offloading before credentials or upload', async () => {
  const f = await setup(), wire = imageServer(f)
  let reads = 0
  const adapter = adapterFor(f, { credential: async () => { reads++; throw new Error('must not read credentials') } })
  try {
    const messages = Array.from({ length: 11 }, (_, n) => ({ ...picture(), id: 'image-' + n }))
    await assert.rejects(() => collect(adapter.stream(options(messages))), e => e.code === 'IMAGE_OFFLOAD_REQUIRED' && e.failure.offloadImages === 1)
    assert.equal(reads, 0); assert.equal(wire.uploads.length, 0)
  } finally { await adapter.dispose(); await f.close() }
})

test('an upload lookup never accepts a file identity belonging to another result', async () => {
  const f = await setup(), wire = imageServer(f), adapter = adapterFor(f)
  const baseFetch = f.web.fetch
  f.web.fetch = (url, init) => new URL(url).pathname.endsWith('/file/fetch_files') ? envelope({ files: [{ id: 'file-wrong', status: 'SUCCESS' }] }) : baseFetch(url, init)
  try {
    await assert.rejects(() => collect(adapter.stream(options())), e => e.code === 'WEB_IDENTITY')
    assert.equal(wire.uploads.length, 1); assert.equal(f.web.generations.length, 0)
  } finally { await adapter.dispose(); await f.close() }
})
