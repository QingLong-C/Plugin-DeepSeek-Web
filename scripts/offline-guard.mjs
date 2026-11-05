// Preloaded into every Node child during offline validation. Only loopback/Unix
// sockets are permitted; real browsers are forbidden even if a test regresses.
import net from 'node:net'
import childProcess from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
const local = host => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(String(host).toLowerCase())
function deny(kind) {
  if (process.env.DSH_OFFLINE_VIOLATIONS) appendFileSync(process.env.DSH_OFFLINE_VIOLATIONS, `${kind}\n`, { mode: 0o600 })
  throw new Error(`Offline validation blocked ${kind}.`)
}
const connect = net.Socket.prototype.connect
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0]
  const options = first && typeof first === 'object' ? first : typeof first === 'string' ? { path: first } : { host: typeof args[1] === 'string' ? args[1] : 'localhost' }
  if (!options.path && !local(options.host ?? 'localhost')) deny('remote socket')
  return connect.apply(this, args)
}
const fetch = globalThis.fetch
if (fetch) globalThis.fetch = function (input, init) {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
  if (!local(url.hostname)) deny('remote fetch')
  return fetch(input, init)
}
for (const method of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
  const original = childProcess[method]
  childProcess[method] = function (command, ...args) {
    if (/chrome|chromium|playwright/i.test(String(command))) deny('browser launch')
    return original.call(this, command, ...args)
  }
}
syncBuiltinESMExports()
