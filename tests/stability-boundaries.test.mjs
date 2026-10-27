import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { LocalStore, digest } from '../lib/local/store.js'
import { TokenFreeError } from '../lib/core/errors.js'
import { writeJson } from '../lib/local/files.js'
import { decodeResponse } from '../lib/core/codec.js'
import { setup, input, frame, snapshot, sse } from './helpers/fixture.mjs'

test('failed cancellation persistence releases account and session leases without replaying the request', async () => {
  const f = await setup()
  try {
    f.web.completion = ({ ready, text, assistant }) => {
      assistant.status = 'WIP'
      return sse(ready + frame(snapshot(text.slice(0, -2), 'WIP')))
    }
    const i = input()
    f.native.begin(i.sessionId)
    const stream = f.engine.run(i, f.accountKey, f.web.client(), AbortSignal.timeout(5000), (text, id) => decodeResponse(text, [], id))[Symbol.asyncIterator]()
    assert.equal((await stream.next()).value.type, 'text')
    const originalUpdate = f.store.update.bind(f.store)
    f.store.update = async (...args) => {
      if (args[2].stopRequested) throw new TokenFreeError('Injected storage failure during cancellation.', 'STATE_STORAGE')
      return originalUpdate(...args)
    }
    await assert.rejects(stream.return(), error => error.code === 'STATE_STORAGE')
    f.store.update = originalUpdate
    const account = await f.store.requestGate(f.accountKey).enter(AbortSignal.timeout(500))
    await account.release()
    const releaseSession = await f.store.sessionLock(f.engine.key(i.sessionId), AbortSignal.timeout(500))
    await releaseSession()
    assert.equal(f.web.generations.length, 1)
    assert.equal((await f.pending()).stage, 'receiving')
  } finally { await f.close() }
})

for (const value of [null, false, 0, '', [], { schemaVersion: 2, confirmed: null }]) {
  test(`damaged session envelope ${JSON.stringify(value)} remains preserved and cannot be treated as empty`, async () => {
    const f = await setup()
    try {
      const key = f.engine.key('damaged-session')
      const file = join(f.home, 'sessions', key + '.json')
      await writeJson(file, value)
      const before = await readFile(file, 'utf8')
      await assert.rejects(f.store.pending(key), error => error.code === 'STATE_STORAGE')
      assert.equal(await readFile(file, 'utf8'), before)
      assert.equal(f.web.generations.length, 0)
    } finally { await f.close() }
  })
}

for (const value of [null, false, 0, '', []]) {
  test(`damaged account envelope ${JSON.stringify(value)} remains preserved and cannot reset its epoch`, async () => {
    const f = await setup()
    try {
      const file = join(f.home, 'account.json')
      await writeJson(file, value)
      const before = await readFile(file, 'utf8')
      await assert.rejects(new LocalStore(f.home).account(), error => error.code === 'STATE_STORAGE')
      assert.equal(await readFile(file, 'utf8'), before)
    } finally { await f.close() }
  })
}

test('missing state still initializes a new account and an empty session', async () => {
  const f = await setup()
  try {
    assert.deepEqual(await f.store.account(), { schemaVersion: 2, epoch: 0 })
    assert.equal(await f.store.pending(digest('missing-session')), undefined)
  } finally { await f.close() }
})
