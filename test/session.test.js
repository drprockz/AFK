import { test } from 'node:test'
import assert from 'node:assert'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

const dbDir = join(tmpdir(), 'afk-session-test-' + Date.now())
mkdirSync(dbDir, { recursive: true })
process.env.AFK_DB_DIR = dbDir

const { ensureSession, estimateTokens } = await import('../src/store/session.js')
const { getDb } = await import('../src/store/db.js')

test('ensureSession creates a row with correct fields', () => {
  const result = ensureSession('sess-1', '/projects/app')
  assert.strictEqual(result.created, true)
  const row = getDb().prepare('SELECT * FROM sessions WHERE id = ?').get('sess-1')
  assert.ok(row)
  assert.strictEqual(row.project_cwd, '/projects/app')
  assert.strictEqual(row.total_req, 0)
  assert.ok(row.started_ts > 0)
})

test('ensureSession is idempotent', () => {
  const result = ensureSession('sess-1', '/projects/app')
  assert.strictEqual(result.created, false)
})

test('estimateTokens — Bash', () => {
  const t = estimateTokens('Bash', { command: 'npm run build' })
  assert.strictEqual(typeof t, 'number')
  assert.strictEqual(t, Math.ceil(13 / 4) + 50)
})

test('estimateTokens — Write', () => {
  const t = estimateTokens('Write', { content: 'hello world', file_path: '/tmp/f.txt' })
  assert.strictEqual(t, Math.ceil(11 / 4) + 50)
})

test('estimateTokens — Edit', () => {
  const t = estimateTokens('Edit', { old_string: 'abc', new_string: 'defgh', file_path: '/tmp/f.txt' })
  assert.strictEqual(t, Math.ceil((3 + 5) / 4) + 50)
})

test('estimateTokens — Read (flat 100)', () => {
  assert.strictEqual(estimateTokens('Read', { file_path: '/tmp/f.txt' }), 100)
})

test('estimateTokens — unknown tool (flat 100)', () => {
  assert.strictEqual(estimateTokens('FutureTool', {}), 100)
})

test('estimateTokens — null/undefined input fields return number, not NaN', () => {
  const t = estimateTokens('Bash', {})
  assert.strictEqual(t, Math.ceil(0 / 4) + 50)
  assert.ok(!Number.isNaN(t))
  const t2 = estimateTokens('Write', {})
  assert.ok(!Number.isNaN(t2))
  const t3 = estimateTokens('Edit', {})
  assert.ok(!Number.isNaN(t3))
})

// ─── Task 2: updateSessionStats + addTokenEstimate ───────────────────────────

const { updateSessionStats, addTokenEstimate } = await import('../src/store/session.js')

test('updateSessionStats increments total_req on every call', () => {
  ensureSession('sess-stats', '/projects/app')
  updateSessionStats('sess-stats', 'allow', 'rule')
  updateSessionStats('sess-stats', 'deny', 'chain')
  const row = getDb().prepare('SELECT * FROM sessions WHERE id = ?').get('sess-stats')
  assert.strictEqual(row.total_req, 2)
})

test('updateSessionStats — prediction+allow → auto_allow', () => {
  ensureSession('sess-pred-allow', '/p')
  updateSessionStats('sess-pred-allow', 'allow', 'prediction')
  const row = getDb().prepare('SELECT * FROM sessions WHERE id = ?').get('sess-pred-allow')
  assert.strictEqual(row.auto_allow, 1)
})

test('updateSessionStats — prediction+deny → auto_deny', () => {
  ensureSession('sess-pred-deny', '/p')
  updateSessionStats('sess-pred-deny', 'deny', 'prediction')
  const row = getDb().prepare('SELECT * FROM sessions WHERE id = ?').get('sess-pred-deny')
  assert.strictEqual(row.auto_deny, 1)
})

test('updateSessionStats — user+allow → user_allow', () => {
  ensureSession('sess-user-allow', '/p')
  updateSessionStats('sess-user-allow', 'allow', 'user')
  const row = getDb().prepare('SELECT * FROM sessions WHERE id = ?').get('sess-user-allow')
  assert.strictEqual(row.user_allow, 1)
})

test('updateSessionStats — user+deny → user_deny', () => {
  ensureSession('sess-user-deny', '/p')
  updateSessionStats('sess-user-deny', 'deny', 'user')
  const row = getDb().prepare('SELECT * FROM sessions WHERE id = ?').get('sess-user-deny')
  assert.strictEqual(row.user_deny, 1)
})

test('updateSessionStats — auto_defer+defer → deferred', () => {
  ensureSession('sess-defer', '/p')
  updateSessionStats('sess-defer', 'defer', 'auto_defer')
  const row = getDb().prepare('SELECT * FROM sessions WHERE id = ?').get('sess-defer')
  assert.strictEqual(row.deferred, 1)
})

test('updateSessionStats — auto_afk → auto_allow', () => {
  ensureSession('sess-afk', '/p')
  updateSessionStats('sess-afk', 'allow', 'auto_afk')
  const row = getDb().prepare('SELECT * FROM sessions WHERE id = ?').get('sess-afk')
  assert.strictEqual(row.auto_allow, 1)
})

test('updateSessionStats — notification+deny → auto_deny', () => {
  ensureSession('sess-notif', '/p')
  updateSessionStats('sess-notif', 'deny', 'notification')
  const row = getDb().prepare('SELECT * FROM sessions WHERE id = ?').get('sess-notif')
  assert.strictEqual(row.auto_deny, 1)
})

test('updateSessionStats — notification+allow → total_req only (unreachable in practice)', () => {
  ensureSession('sess-notif-allow', '/p')
  updateSessionStats('sess-notif-allow', 'allow', 'notification')
  const row = getDb().prepare('SELECT * FROM sessions WHERE id = ?').get('sess-notif-allow')
  assert.strictEqual(row.auto_allow, 0)
  assert.strictEqual(row.total_req, 1)
})

test('addTokenEstimate increments tokens_est', () => {
  ensureSession('sess-tokens', '/p')
  addTokenEstimate('sess-tokens', 100)
  addTokenEstimate('sess-tokens', 50)
  const row = getDb().prepare('SELECT * FROM sessions WHERE id = ?').get('sess-tokens')
  assert.strictEqual(row.tokens_est, 150)
})

// ─── Task 3: getSession, listSessions, getMostRecentSession ──────────────────

const { getSession, listSessions, getMostRecentSession } = await import('../src/store/session.js')

test('getSession returns null for nonexistent ID', () => {
  assert.strictEqual(getSession('nonexistent'), null)
})

test('getSession returns row for existing session', () => {
  ensureSession('sess-get', '/p')
  const row = getSession('sess-get')
  assert.ok(row)
  assert.strictEqual(row.id, 'sess-get')
})

test('listSessions returns paginated results in descending order', () => {
  ensureSession('sess-list-old', '/p')
  const db = getDb()
  db.prepare('UPDATE sessions SET started_ts = started_ts - 100000 WHERE id = ?').run('sess-list-old')
  ensureSession('sess-list-new', '/p')

  const { sessions, total, page, limit } = listSessions({ page: 1, limit: 2 })
  assert.strictEqual(page, 1)
  assert.strictEqual(limit, 2)
  assert.strictEqual(sessions.length, 2)
  assert.ok(total >= 2)
  assert.ok(sessions[0].started_ts >= sessions[1].started_ts)
})

test('getMostRecentSession returns the latest session', () => {
  const row = getMostRecentSession()
  assert.ok(row)
  assert.ok(row.started_ts > 0)
})
