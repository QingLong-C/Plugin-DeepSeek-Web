import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { evaluatePluginCompatibility } from '@deepseek-ai/dsh-app-boot'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)))

test('DSH compatibility survives patch and minor prereleases in the supported series', () => {
  for (const runtime of ['0.2.1-rc.3', '0.2.1-rc.5', '0.2.1-rc.6', '0.2.1', '0.2.2-rc.1', '0.2.9']) {
    assert.equal(evaluatePluginCompatibility(manifest, {}, runtime), undefined, runtime)
  }
})

test('DSH compatibility retains the lower bound and rejects a new breaking series', () => {
  for (const runtime of ['0.1.9', '0.2.1-rc.2', '0.3.0-rc.1', '0.3.0', '1.0.0']) {
    const issue = evaluatePluginCompatibility(manifest, {}, runtime)
    assert.ok(issue, runtime)
    assert.equal(issue.exempted, false)
  }
})
