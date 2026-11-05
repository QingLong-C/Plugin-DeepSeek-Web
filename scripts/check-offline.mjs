import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const home = mkdtempSync(join(tmpdir(), 'tokenfree-offline-'))
const violations = join(home, 'violations.txt')
const env = { ...process.env, DSH_TOKENFREE_HOME: join(home, 'account'), DSH_HOME: join(home, 'dsh'), DSH_OFFLINE_VIOLATIONS: violations,
  NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${fileURLToPath(new URL('./offline-guard.mjs', import.meta.url))}`.trim() }
for (const key of Object.keys(env)) if (key.startsWith('DEEPSEEK_WEB_')) delete env[key]
try {
  const result = spawnSync('pnpm', ['check'], { env, stdio: 'inherit' })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, 'Offline validation failed')
  assert(!existsSync(violations), existsSync(violations) ? readFileSync(violations, 'utf8') : '')
  console.log('Offline guard passed: zero remote network attempts; no real browser; isolated account and DSH homes.')
} finally { rmSync(home, { recursive: true, force: true }) }
