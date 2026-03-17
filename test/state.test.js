import { test } from 'node:test'
import assert from 'node:assert'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

const testStateDir = join(tmpdir(), 'afk-state-test-' + Date.now())
mkdirSync(testStateDir, { recursive: true })
process.env.AFK_STATE_DIR = testStateDir

const { isAfk, setAfk, getSessionId, appendDigest, getAndClearDigest, getState, touchLastRequestTs } =
  await import('../src/afk/state.js')

test('isAfk returns false by default', () => {
  assert.strictEqual(isAfk(), false)
})

test('setAfk(true) sets AFK on', () => {
  setAfk(true)
  assert.strictEqual(isAfk(), true)
})

test('setAfk(false) sets AFK off', () => {
  setAfk(false)
  assert.strictEqual(isAfk(), false)
})

test('setAfk(true, 30) sets afk_until 30 minutes from now', async () => {
  const before = Date.now()
  setAfk(true, 30)
  assert.strictEqual(isAfk(), true)
  // state file should have afk_until roughly 30 min from now
  const { readFileSync } = await import('node:fs')
  const state = JSON.parse(readFileSync(join(testStateDir, 'state.json'), 'utf8'))
  assert.ok(state.afk_until > before + 29 * 60 * 1000)
  assert.ok(state.afk_until < before + 31 * 60 * 1000)
})

test('getSessionId returns a stable UUID', () => {
  const id1 = getSessionId()
  const id2 = getSessionId()
  assert.strictEqual(id1, id2)
  assert.match(id1, /^[0-9a-f-]{36}$/)
})

test('appendDigest and getAndClearDigest round-trip', () => {
  getAndClearDigest() // clear any prior state
  appendDigest({ tool: 'Bash', command: 'npm test', decision: 'allow' })
  appendDigest({ tool: 'Write', path: '/src/app.js', decision: 'allow' })
  const entries = getAndClearDigest()
  assert.strictEqual(entries.length, 2)
  assert.strictEqual(entries[0].tool, 'Bash')
  // cleared
  assert.strictEqual(getAndClearDigest().length, 0)
})

test('getState returns the full state object', () => {
  const state = getState()
  assert.ok(typeof state === 'object')
  assert.ok('afk' in state)
  assert.ok('session_id' in state)
  assert.ok('auto_afk_minutes' in state)
})

test('touchLastRequestTs updates last_request_ts without wiping other fields', () => {
  setAfk(true)
  touchLastRequestTs()
  const state = getState()
  assert.ok(typeof state.last_request_ts === 'number', 'last_request_ts should be a number')
  assert.strictEqual(state.afk, true, 'afk flag must survive the write')
  setAfk(false)
})
