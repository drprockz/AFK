import { test, before, after } from 'node:test'
import assert from 'node:assert'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, rmSync } from 'node:fs'

// Isolate all AFK data stores before any module imports
const testDir = join(tmpdir(), 'afk-dashboard-test-' + Date.now())
mkdirSync(testDir, { recursive: true })
process.env.AFK_DB_DIR     = testDir
process.env.AFK_STATE_DIR  = testDir
process.env.AFK_CONFIG_DIR = testDir

const { startServer, stopServer } = await import('../src/dashboard/server.js')

// imports needed for seeding — added after existing imports
const { logDecision } = await import('../src/store/history.js')
const { enqueueDeferred } = await import('../src/store/queue.js')
const { addRule } = await import('../src/engine/rules.js')

// seed function used in before()
function seed() {
  // 3 decisions
  const d1 = logDecision({
    session_id: 'sess-1', tool: 'Bash',
    input: { command: 'npm run build' }, command: 'npm run build', path: null,
    decision: 'allow', source: 'prediction', confidence: 0.92,
    rule_id: null, reason: null, project_cwd: '/projects/app'
  })
  const d2 = logDecision({
    session_id: 'sess-1', tool: 'Read',
    input: { file_path: '/src/index.js' }, command: null, path: '/src/index.js',
    decision: 'allow', source: 'rule', confidence: null,
    rule_id: null, reason: null, project_cwd: '/projects/app'
  })
  const d3 = logDecision({
    session_id: 'sess-1', tool: 'Bash',
    input: { command: 'rm -rf dist/' }, command: 'rm -rf dist/', path: null,
    decision: 'defer', source: 'auto_defer', confidence: null,
    rule_id: null, reason: 'destructive', project_cwd: '/projects/app'
  })
  // 1 deferred item
  enqueueDeferred({
    decisionsId: d3, sessionId: 'sess-1', tool: 'Bash',
    input: { command: 'rm -rf dist/' }, command: 'rm -rf dist/', path: null
  })
  // 1 rule
  addRule({ tool: 'Bash', pattern: 'npm *', action: 'allow', label: 'npm commands' })
}

// ── helpers ──────────────────────────────────────────────────────────────────
const BASE = 'http://127.0.0.1:16789'
async function get(path) {
  const res = await fetch(`${BASE}${path}`)
  return { status: res.status, body: await res.json() }
}
async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  return { status: res.status, body: await res.json() }
}
async function del(path) {
  const res = await fetch(`${BASE}${path}`, { method: 'DELETE' })
  return { status: res.status, body: await res.json() }
}

before(async () => {
  seed()
  startServer(16789)
  await new Promise(r => setTimeout(r, 100))
})

after(async () => {
  await stopServer()
  rmSync(testDir, { recursive: true, force: true })
})

test('GET /api/status returns ok', async () => {
  const { status, body } = await get('/api/status')
  assert.strictEqual(status, 200)
  assert.ok('ok' in body)
})

// ── GET /api/status ──────────────────────────────────────────────────────────
test('GET /api/status returns expected shape', async () => {
  const { status, body } = await get('/api/status')
  assert.strictEqual(status, 200)
  assert.ok('afk' in body, 'has afk field')
  assert.ok('queue_count' in body, 'has queue_count')
  assert.ok('project_cwd' in body, 'has project_cwd')
  assert.ok('today' in body, 'has today')
  assert.ok('total' in body.today && 'auto_approved' in body.today)
})

// ── GET /api/decisions ────────────────────────────────────────────────────────
test('GET /api/decisions returns items with pagination', async () => {
  const { status, body } = await get('/api/decisions')
  assert.strictEqual(status, 200)
  assert.ok(Array.isArray(body.items))
  assert.ok(typeof body.total === 'number')
  assert.ok(typeof body.page === 'number')
  assert.ok(typeof body.pages === 'number')
})

test('GET /api/decisions?tool=Bash filters by tool', async () => {
  const { body } = await get('/api/decisions?tool=Bash')
  assert.ok(body.items.every(i => i.tool === 'Bash'), 'all items are Bash')
})

// ── GET /api/queue ────────────────────────────────────────────────────────────
test('GET /api/queue returns pending deferred items', async () => {
  const { status, body } = await get('/api/queue')
  assert.strictEqual(status, 200)
  assert.ok(Array.isArray(body))
  assert.ok(body.length >= 1)
  assert.ok('tool' in body[0] && 'command' in body[0])
})

// ── POST /api/queue/:id ───────────────────────────────────────────────────────
test('POST /api/queue/:id with allow returns final:allow', async () => {
  const queue = (await get('/api/queue')).body
  const id = queue[0].id
  const { status, body } = await post(`/api/queue/${id}`, { action: 'allow' })
  assert.strictEqual(status, 200)
  assert.strictEqual(body.final, 'allow')
  assert.strictEqual(body.id, id)
})

test('POST /api/queue/:id with invalid action returns 400', async () => {
  const { status, body } = await post('/api/queue/1', { action: 'nope' })
  assert.strictEqual(status, 400)
  assert.ok(body.error.includes('invalid action'))
})

// ── GET /api/rules ────────────────────────────────────────────────────────────
test('GET /api/rules returns array of rules', async () => {
  const { status, body } = await get('/api/rules')
  assert.strictEqual(status, 200)
  assert.ok(Array.isArray(body))
  assert.ok(body.length >= 1)
  assert.ok('id' in body[0] && 'tool' in body[0] && 'action' in body[0])
})

// ── POST /api/rules ───────────────────────────────────────────────────────────
test('POST /api/rules creates a rule and returns full object', async () => {
  const { status, body } = await post('/api/rules', {
    tool: 'Read', pattern: 'src/*', action: 'allow', label: 'src reads'
  })
  assert.strictEqual(status, 200)
  assert.ok('id' in body, 'has id')
  assert.ok('created_ts' in body, 'has created_ts')
  assert.strictEqual(body.tool, 'Read')
})

test('POST /api/rules with missing tool returns 400', async () => {
  const { status, body } = await post('/api/rules', { pattern: '*', action: 'allow' })
  assert.strictEqual(status, 400)
  assert.ok(body.error.includes('tool'))
})

// ── DELETE /api/rules/:id ─────────────────────────────────────────────────────
test('DELETE /api/rules/:id returns deleted:true', async () => {
  const rules = (await get('/api/rules')).body
  const id = rules[0].id
  const { status, body } = await del(`/api/rules/${id}`)
  assert.strictEqual(status, 200)
  assert.strictEqual(body.deleted, true)
})

// ── GET /api/stats ────────────────────────────────────────────────────────────
test('GET /api/stats returns by_tool, top_patterns, by_source', async () => {
  const { status, body } = await get('/api/stats')
  assert.strictEqual(status, 200)
  assert.ok(Array.isArray(body.by_tool), 'by_tool is array')
  assert.ok(Array.isArray(body.top_patterns), 'top_patterns is array')
  assert.ok(typeof body.by_source === 'object', 'by_source is object')
})

// ── GET /api/digest ───────────────────────────────────────────────────────────
test('GET /api/digest returns digest string', async () => {
  const { status, body } = await get('/api/digest')
  assert.strictEqual(status, 200)
  assert.ok(typeof body.digest === 'string')
  assert.ok(body.digest.length > 0)
})

// ── POST /api/afk ─────────────────────────────────────────────────────────────
test('POST /api/afk toggles AFK state', async () => {
  const { status, body } = await post('/api/afk', { on: true })
  assert.strictEqual(status, 200)
  assert.strictEqual(body.afk, true)
  // reset
  await post('/api/afk', { on: false })
})

// ── GET /api/export ───────────────────────────────────────────────────────────
test('GET /api/export?format=csv returns CSV with Content-Disposition', async () => {
  const res = await fetch(`${BASE}/api/export?format=csv`)
  assert.strictEqual(res.status, 200)
  const cd = res.headers.get('content-disposition')
  assert.ok(cd && cd.includes('afk-decisions.csv'), `got: ${cd}`)
  const text = await res.text()
  assert.ok(text.startsWith('id,ts,tool'), 'CSV has header row')
})

test('GET /api/export?format=json returns JSON array with Content-Disposition', async () => {
  const res = await fetch(`${BASE}/api/export?format=json`)
  assert.strictEqual(res.status, 200)
  const cd = res.headers.get('content-disposition')
  assert.ok(cd && cd.includes('afk-decisions.json'), `got: ${cd}`)
  const body = await res.json()
  assert.ok(Array.isArray(body))
})
