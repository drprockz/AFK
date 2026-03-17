import { test } from 'node:test'
import assert from 'node:assert'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AFK_DB_DIR = join(tmpdir(), 'afk-anomaly-test-' + Date.now())

const { detectAnomaly } = await import('../src/engine/anomaly.js')
const { getDb } = await import('../src/store/db.js')

// Helper: seed a baseline row directly
function seedBaseline({ project_cwd, tool, pattern, count }) {
  getDb().prepare(`
    INSERT INTO baselines (project_cwd, tool, pattern, count, last_seen)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(project_cwd, tool, pattern) DO UPDATE SET count = excluded.count
  `).run(project_cwd, tool, pattern, count, Date.now())
}

const CWD = '/projects/myapp'

// Seed enough total baselines (≥10) so anomaly detection activates.
// Without this, the minimum-baseline check returns early (fresh install guard).
for (let i = 0; i < 5; i++) {
  seedBaseline({ project_cwd: CWD, tool: 'Read', pattern: `src/file${i}.*`, count: 3 })
}

test('never-seen pattern → anomalous=true, score=1.0', () => {
  const r = detectAnomaly({ tool: 'Bash', input: { command: 'zz-never-seen-xyzzy' }, cwd: CWD })
  assert.strictEqual(r.anomalous, true)
  assert.strictEqual(r.score, 1.0)
})

test('count=1 (rarely seen) → anomalous=true, score=0.7', () => {
  seedBaseline({ project_cwd: CWD, tool: 'Bash', pattern: 'npm run', count: 1 })
  const r = detectAnomaly({ tool: 'Bash', input: { command: 'npm run build' }, cwd: CWD })
  assert.strictEqual(r.anomalous, true)
  assert.strictEqual(r.score, 0.7)
})

test('count=2 (rarely seen, upper boundary) → anomalous=true, score=0.7', () => {
  seedBaseline({ project_cwd: CWD, tool: 'Bash', pattern: 'yarn install', count: 2 })
  const r = detectAnomaly({ tool: 'Bash', input: { command: 'yarn install --frozen-lockfile' }, cwd: CWD })
  assert.strictEqual(r.anomalous, true)
  assert.strictEqual(r.score, 0.7)
})

test('count=5 (occasionally seen) → anomalous=false, score=0.3', () => {
  seedBaseline({ project_cwd: CWD, tool: 'Bash', pattern: 'jest --watch', count: 5 })
  const r = detectAnomaly({ tool: 'Bash', input: { command: 'jest --watch --coverage' }, cwd: CWD })
  assert.strictEqual(r.anomalous, false)
  assert.strictEqual(r.score, 0.3)
})

test('count=10 (common, lower boundary) → anomalous=false, score=0.0', () => {
  seedBaseline({ project_cwd: CWD, tool: 'Bash', pattern: 'git status', count: 10 })
  const r = detectAnomaly({ tool: 'Bash', input: { command: 'git status --short' }, cwd: CWD })
  assert.strictEqual(r.anomalous, false)
  assert.strictEqual(r.score, 0.0)
})

test('outside-cwd /etc/ path → anomalous=true, score≥0.8 (overrides frequency)', () => {
  // count=10 would give score=0.0 from frequency, but outside-cwd forces ≥0.8
  seedBaseline({ project_cwd: CWD, tool: 'Bash', pattern: 'cat /etc/hosts', count: 10 })
  const r = detectAnomaly({ tool: 'Bash', input: { command: 'cat /etc/hosts' }, cwd: CWD })
  assert.strictEqual(r.anomalous, true)
  assert.ok(r.score >= 0.8, `score should be ≥0.8, got ${r.score}`)
  assert.ok(r.reason.includes('/etc/hosts'), 'reason should include the suspicious token')
})

// MUST be last — closes the DB singleton, corrupting it for the test process
test('DB error (closed connection) → anomalous=false, score=0, no throw', () => {
  getDb().close()
  let r
  assert.doesNotThrow(() => {
    r = detectAnomaly({ tool: 'Bash', input: { command: 'npm test' }, cwd: CWD })
  })
  assert.strictEqual(r.anomalous, false)
  assert.strictEqual(r.score, 0)
})
