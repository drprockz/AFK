import { test } from 'node:test'
import assert from 'node:assert'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AFK_DB_DIR = join(tmpdir(), 'afk-queue-test-' + Date.now())

const { enqueueDeferred, getPendingItems, resolveItem, getPendingCount, getItemById } =
  await import('../src/store/queue.js')

// A minimal logDecision call to get a valid decisions.id for FK constraint
const { logDecision } = await import('../src/store/history.js')
function makeDecisionsId() {
  return logDecision({
    session_id: 'test-session', tool: 'Bash',
    input: { command: 'rm -rf dist/' }, command: 'rm -rf dist/', path: null,
    decision: 'defer', source: 'auto_defer', confidence: null, rule_id: null,
    reason: 'test', project_cwd: '/projects/app'
  })
}

test('enqueueDeferred inserts row and returns numeric id', () => {
  const decisionsId = makeDecisionsId()
  const id = enqueueDeferred({
    decisionsId,
    sessionId: 'test-session',
    tool: 'Bash',
    input: { command: 'rm -rf dist/' },
    command: 'rm -rf dist/',
    path: null
  })
  assert.ok(typeof id === 'number' && id > 0, 'should return a positive integer id')
})

test('getPendingItems returns only unreviewed rows, oldest first', () => {
  const d1 = makeDecisionsId()
  const d2 = makeDecisionsId()
  enqueueDeferred({ decisionsId: d1, sessionId: 's', tool: 'Bash', input: { command: 'rm a' }, command: 'rm a', path: null })
  enqueueDeferred({ decisionsId: d2, sessionId: 's', tool: 'Bash', input: { command: 'rm b' }, command: 'rm b', path: null })
  const items = getPendingItems()
  assert.ok(items.length >= 2, 'at least 2 pending items')
  assert.ok(items[0].ts <= items[1].ts, 'oldest first')
  assert.ok(items.every(i => i.reviewed === 0), 'all returned items must be unreviewed')
})

test('resolveItem marks row reviewed and returns true', () => {
  const decisionsId = makeDecisionsId()
  const id = enqueueDeferred({
    decisionsId, sessionId: 's', tool: 'Bash',
    input: { command: 'drop table' }, command: 'drop table', path: null
  })
  const updated = resolveItem(id, 'deny')
  assert.strictEqual(updated, true, 'should return true when row was updated')
  const remaining = getPendingItems().filter(i => i.id === id)
  assert.strictEqual(remaining.length, 0, 'resolved item should not appear in pending list')
})

test('resolveItem with non-existent id returns false (silent no-op)', () => {
  const updated = resolveItem(999999, 'allow')
  assert.strictEqual(updated, false, 'should return false for missing id')
})

test('getItemById returns row by id', () => {
  const decisionsId = makeDecisionsId()
  const id = enqueueDeferred({
    decisionsId,
    sessionId: 'test-session',
    tool: 'Write',
    input: { file_path: '/tmp/foo.js' },
    command: null,
    path: '/tmp/foo.js'
  })
  const row = getItemById(id)
  assert.ok(row !== null, 'row found')
  assert.strictEqual(row.id, id)
  assert.strictEqual(row.tool, 'Write')
  assert.strictEqual(row.path, '/tmp/foo.js')
})

test('getItemById returns null for unknown id', () => {
  const row = getItemById(999999)
  assert.strictEqual(row, null)
})
