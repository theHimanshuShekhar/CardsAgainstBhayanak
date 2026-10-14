import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

for (const origin of [
  '',
  'http://cards.example.com',
  'https://user:secret@cards.example.com',
  'https://cards.example.com/path',
  'https://cards.example.com?token=secret',
  'javascript:alert(1)',
  'http://localhost:3000',
]) {
  test(`production startup refuses unsafe public origin ${origin}`, () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'server.prod.ts'], {
      env: { ...process.env, NODE_ENV: 'production', PUBLIC_SITE_URL: origin },
      encoding: 'utf8',
      timeout: 10000,
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /PUBLIC_SITE_URL/)
  })
}
