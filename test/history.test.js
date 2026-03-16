import { test } from 'node:test'
import assert from 'node:assert'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AFK_DB_DIR = join(tmpdir(), 'afk-history-test-' + Date.now())

const { logDecision, queryByPattern, updateBaseline } = await import('../src/store/history.js')
const { getDb } = await import('../src/store/db.js')

const baseDecision = {
  session_id: 'test-session',
  tool: 'Bash',
  input: { command: 'npm run test' },
  command: 'npm run test',
  path: null,
  decision: 'allow',
  source: 'prediction',
  confidence: 0.92,
  rule_id: null,
  reason: 'High confidence from history',
  project_cwd: '/projects/myapp'
}

test('logDecision stores a sanitized row', () => {
  const id = logDecision(baseDecision)
  assert.ok(typeof id === 'number' && id > 0, 'should return inserted row id')
})

test('logDecision strips Write content before storing', async () => {
  const { getDb } = await import('../src/store/db.js')
  const id = logDecision({
    ...baseDecision,
    tool: 'Write',
    input: { file_path: '/src/app.js', content: 'x'.repeat(100_000) },
    command: null,
    path: '/src/app.js',
    decision: 'allow',
    source: 'auto_afk'
  })
  const row = getDb().prepare('SELECT input FROM decisions WHERE id = ?').get(id)
  const parsed = JSON.parse(row.input)
  assert.ok(!('content' in parsed), 'content should be stripped')
  assert.strictEqual(parsed.file_path, '/src/app.js')
})

test('queryByPattern returns matching decisions sorted by recency', () => {
  // Insert 3 decisions for same tool+pattern in same project
  for (let i = 0; i < 3; i++) {
    logDecision({ ...baseDecision, decision: i % 2 === 0 ? 'allow' : 'deny' })
  }
  const rows = queryByPattern({ tool: 'Bash', pattern: 'npm run test', project_cwd: '/projects/myapp' })
  assert.ok(rows.length >= 3, 'should find at least 3 matching rows')
  // most recent first
  assert.ok(rows[0].ts >= rows[1].ts)
})

test('queryByPattern ignores decisions older than 90 days', async () => {
  const oldTs = Date.now() - (91 * 24 * 60 * 60 * 1000)
  getDb().prepare(`
    INSERT INTO decisions (ts, session_id, tool, input, command, decision, source, project_cwd)
    VALUES (?, 'old-session', 'Bash', '{"command":"npm run test"}', 'npm run test', 'allow', 'prediction', '/projects/myapp')
  `).run(oldTs)
  const rows = queryByPattern({ tool: 'Bash', pattern: 'npm run test', project_cwd: '/projects/myapp' })
  const tooOld = rows.find(r => r.ts === oldTs)
  assert.strictEqual(tooOld, undefined, 'old decision should be excluded')
})

test('updateBaseline creates a new baseline row with count=1 for unseen pattern', () => {
  const request = {
    tool: 'Bash',
    input: { command: 'npm run lint' },
    cwd: '/projects/testapp'
  }
  updateBaseline(request)
  const row = getDb().prepare(`
    SELECT count FROM baselines
    WHERE project_cwd = ? AND tool = ? AND pattern = ?
  `).get('/projects/testapp', 'Bash', 'npm run')
  assert.strictEqual(row.count, 1, 'count should be 1 for first insert')
})

test('updateBaseline increments count on second call for same key', () => {
  const request = {
    tool: 'Bash',
    input: { command: 'npm run lint' },
    cwd: '/projects/testapp2'
  }
  updateBaseline(request)
  updateBaseline(request)
  const row = getDb().prepare(`
    SELECT count FROM baselines
    WHERE project_cwd = ? AND tool = ? AND pattern = ?
  `).get('/projects/testapp2', 'Bash', 'npm run')
  assert.strictEqual(row.count, 2, 'count should increment to 2, not create duplicate row')
})
