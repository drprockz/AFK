import { test } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Unique state dir per test run — isolate from other tests
const stateDir = mkdtempSync(join(tmpdir(), 'afk-detector-test-'))
process.env.AFK_STATE_DIR = stateDir

const { checkAndAutoAfk } = await import('../src/afk/detector.js')
const { getState, setAfk, isAfk } = await import('../src/afk/state.js')

// Helper: manually set last_request_ts in state file (bypasses the public API for test setup)
import { writeFileSync, readFileSync } from 'node:fs'
function setLastRequestTs(ts) {
  const statePath = join(stateDir, 'state.json')
  let state
  try { state = JSON.parse(readFileSync(statePath, 'utf8')) } catch { state = {} }
  writeFileSync(statePath, JSON.stringify({ ...state, last_request_ts: ts }))
}
function setAutoAfkMinutes(mins) {
  const statePath = join(stateDir, 'state.json')
  let state
  try { state = JSON.parse(readFileSync(statePath, 'utf8')) } catch { state = {} }
  writeFileSync(statePath, JSON.stringify({ ...state, auto_afk_minutes: mins }))
}

test('no auto-AFK on first invocation (last_request_ts is null)', () => {
  setAfk(false)
  setLastRequestTs(null)
  setAutoAfkMinutes(15)
  checkAndAutoAfk()
  assert.strictEqual(isAfk(), false, 'should not enable AFK on first call')
  const state = getState()
  assert.ok(typeof state.last_request_ts === 'number', 'last_request_ts should be set after call')
})

test('no auto-AFK when gap is less than threshold', () => {
  setAfk(false)
  setLastRequestTs(Date.now() - 5 * 60 * 1000) // 5 minutes ago (threshold is 15 min)
  setAutoAfkMinutes(15)
  checkAndAutoAfk()
  assert.strictEqual(isAfk(), false, 'should not enable AFK when gap < threshold')
})

test('auto-AFK triggered when gap exceeds threshold', () => {
  setAfk(false)
  setLastRequestTs(Date.now() - 20 * 60 * 1000) // 20 minutes ago (threshold is 15 min)
  setAutoAfkMinutes(15)
  checkAndAutoAfk()
  assert.strictEqual(isAfk(), true, 'should enable AFK when gap > threshold')
  setAfk(false) // cleanup
})

test('no auto-AFK when auto_afk_minutes is 0 (disabled)', () => {
  setAfk(false)
  setLastRequestTs(Date.now() - 60 * 60 * 1000) // 1 hour ago — would normally trigger
  setAutoAfkMinutes(0)
  checkAndAutoAfk()
  assert.strictEqual(isAfk(), false, 'auto-AFK disabled when auto_afk_minutes=0')
  setAutoAfkMinutes(15) // restore
})

test('last_request_ts is always updated, even when auto-AFK is skipped', () => {
  setAfk(false)
  const before = Date.now()
  setLastRequestTs(before - 5 * 60 * 1000)
  setAutoAfkMinutes(15)
  checkAndAutoAfk()
  const state = getState()
  assert.ok(state.last_request_ts >= before, 'last_request_ts must be updated to now')
})
