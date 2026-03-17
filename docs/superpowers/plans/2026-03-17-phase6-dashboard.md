# Phase 6 — Web Dashboard Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local Express dashboard at `http://localhost:6789` for reviewing deferred actions, browsing history, managing rules, and monitoring AFK session activity.

**Architecture:** Three server files (`server.js`, `api.js`, three UI files) backed by new store query functions. The server is spawned as a detached child process by `afk-review-cli.js`; tests start it in-process on port 16789. All DB access goes through store modules — no raw SQL in `api.js`.

**Tech Stack:** Node.js 18+ ESM, Express (install as dependency), better-sqlite3 (existing), plain HTML/vanilla JS/CSS (no bundler, no CDN), node:test + node:assert

---

## Chunk 1: Store Layer Additions

### Task 1: `listDecisions`, `getTodayStats`, `getDecisionStats` in `history.js`

**Files:**
- Modify: `src/store/history.js` (append after existing exports)
- Modify: `test/history.test.js` (append new tests)

**Context:** `src/store/history.js` starts with `import { getDb } from './db.js'` and has a `NINETY_DAYS_MS` constant already defined. The DB is SQLite via `better-sqlite3` (synchronous). Tests set `process.env.AFK_DB_DIR` before any imports. Run tests with `node --test test/history.test.js`.

- [ ] **Step 1: Write failing tests for `listDecisions`**

Extend the existing import on line 8 of `test/history.test.js` — add `listDecisions` to the destructuring:

```js
// line 8 becomes:
const { logDecision, queryByPattern, updateBaseline, listDecisions } = await import('../src/store/history.js')
```

Then append the new tests:

```js
test('listDecisions returns paginated items and total', () => {
  // seed 3 decisions with different tools
  for (const tool of ['Bash', 'Bash', 'Read']) {
    logDecision({ ...baseDecision, tool, decision: 'allow' })
  }
  const result = listDecisions({ page: 1, limit: 2 })
  assert.ok(Array.isArray(result.items), 'items is array')
  assert.strictEqual(result.items.length, 2, 'respects limit')
  assert.ok(result.total >= 3, 'total reflects all rows')
  assert.strictEqual(result.page, 1)
  assert.ok(result.pages >= 2)
})

test('listDecisions filters by tool', () => {
  const result = listDecisions({ tool: 'Read' })
  assert.ok(result.items.every(i => i.tool === 'Read'), 'all items are Read')
})

test('listDecisions filters by decision', () => {
  logDecision({ ...baseDecision, decision: 'deny', source: 'rule' })
  const result = listDecisions({ decision: 'deny' })
  assert.ok(result.items.every(i => i.decision === 'deny'))
})

test('listDecisions returns correct item shape', () => {
  const result = listDecisions({ limit: 1 })
  const item = result.items[0]
  assert.ok('id' in item && 'ts' in item && 'tool' in item && 'decision' in item && 'source' in item)
})
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
node --test test/history.test.js
```

Expected: FAIL with `listDecisions is not a function`.

- [ ] **Step 3: Implement `listDecisions` in `src/store/history.js`**

Append after the `updateBaseline` function:

```js
/**
 * Returns a paginated list of decisions, optionally filtered.
 * @param {object} opts
 * @param {number} [opts.page=1]
 * @param {number} [opts.limit=50]
 * @param {string} [opts.tool]
 * @param {string} [opts.source]
 * @param {string} [opts.decision]
 * @param {string} [opts.date] — ISO date string (UTC calendar day filter)
 * @returns {{ items: object[], total: number, page: number, pages: number }}
 */
export function listDecisions({ page = 1, limit = 50, tool, source, decision, date } = {}) {
  const db = getDb()
  const cap = Math.min(Math.max(1, limit), 10000)
  const offset = (Math.max(1, page) - 1) * cap

  const conditions = []
  const params = []

  if (tool) { conditions.push('tool = ?'); params.push(tool) }
  if (source) { conditions.push('source = ?'); params.push(source) }
  if (decision) { conditions.push('decision = ?'); params.push(decision) }
  if (date) {
    const day = new Date(date)
    day.setUTCHours(0, 0, 0, 0)
    const start = day.getTime()
    const end = start + 86400000
    conditions.push('ts >= ? AND ts < ?')
    params.push(start, end)
  }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''

  const total = db.prepare(`SELECT COUNT(*) as c FROM decisions ${where}`).get(...params).c
  const items = db.prepare(
    `SELECT id, ts, tool, command, path, decision, source, confidence, reason
     FROM decisions ${where} ORDER BY ts DESC LIMIT ? OFFSET ?`
  ).all(...params, cap, offset)

  const pages = Math.max(1, Math.ceil(total / cap))
  return { items, total, page: Math.max(1, page), pages }
}

/**
 * Returns decision counts for the current UTC calendar day.
 * @returns {{ total: number, auto_approved: number, auto_denied: number, deferred: number }}
 */
export function getTodayStats() {
  const db = getDb()
  const start = new Date().setUTCHours(0, 0, 0, 0)
  const row = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN decision = 'allow' AND source != 'user' THEN 1 ELSE 0 END) as auto_approved,
      SUM(CASE WHEN decision = 'deny'  AND source != 'user' THEN 1 ELSE 0 END) as auto_denied,
      SUM(CASE WHEN decision = 'defer' THEN 1 ELSE 0 END) as deferred
    FROM decisions WHERE ts >= ?
  `).get(start)
  return {
    total:         row.total         ?? 0,
    auto_approved: row.auto_approved ?? 0,
    auto_denied:   row.auto_denied   ?? 0,
    deferred:      row.deferred      ?? 0
  }
}

/**
 * Returns aggregated decision stats over the last 90 days.
 * @returns {{ by_tool: object[], top_patterns: object[], by_source: object }}
 */
export function getDecisionStats() {
  const db = getDb()
  const cutoff = Date.now() - NINETY_DAYS_MS

  const by_tool = db.prepare(`
    SELECT tool,
           COUNT(*) as total,
           SUM(decision = 'allow') as allow,
           SUM(decision = 'deny')  as deny,
           SUM(decision = 'defer') as defer
    FROM decisions WHERE ts >= ?
    GROUP BY tool ORDER BY total DESC
  `).all(cutoff)

  const top_patterns = db.prepare(`
    SELECT tool,
           COALESCE(command, path, tool) as pattern,
           COUNT(*) as total,
           ROUND(AVG(decision = 'allow'), 2) as allow_rate
    FROM decisions WHERE ts >= ?
    GROUP BY tool, pattern ORDER BY total DESC LIMIT 20
  `).all(cutoff)

  const sourceRows = db.prepare(`
    SELECT source, COUNT(*) as count FROM decisions WHERE ts >= ? GROUP BY source
  `).all(cutoff)
  const by_source = Object.fromEntries(sourceRows.map(r => [r.source, r.count]))

  return { by_tool, top_patterns, by_source }
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
node --test test/history.test.js
```

Expected: all tests PASS.

- [ ] **Step 5: Write failing tests for `getTodayStats`**

Extend the existing import on line 8 of `test/history.test.js` — add `getTodayStats` to the destructuring:

```js
// line 8 becomes:
const { logDecision, queryByPattern, updateBaseline, listDecisions, getTodayStats } = await import('../src/store/history.js')
```

Then append the new test (the DB is shared, so use delta comparison to avoid false failures from rows seeded by earlier tests):

```js
test('getTodayStats returns correct counts for today', () => {
  const before = getTodayStats()
  // seed: 2 auto-allow, 1 user-deny, 1 defer
  logDecision({ ...baseDecision, decision: 'allow', source: 'prediction' })
  logDecision({ ...baseDecision, decision: 'allow', source: 'rule' })
  logDecision({ ...baseDecision, decision: 'deny',  source: 'user' })
  logDecision({ ...baseDecision, decision: 'defer', source: 'auto_defer' })
  const after = getTodayStats()
  assert.strictEqual(after.auto_approved - before.auto_approved, 2, '2 non-user allows added')
  assert.strictEqual(after.auto_denied   - before.auto_denied,   0, 'user deny did not count as auto_denied')
  assert.strictEqual(after.deferred      - before.deferred,      1, '1 defer added')
  assert.ok(after.total >= before.total + 4)
})
```

- [ ] **Step 6: Run tests — verify new test passes**

```bash
node --test test/history.test.js
```

Expected: all tests PASS.

- [ ] **Step 7: Write failing tests for `getDecisionStats`**

Extend the existing import on line 8 — add `getDecisionStats` to the destructuring:

```js
// line 8 becomes:
const { logDecision, queryByPattern, updateBaseline, listDecisions, getTodayStats, getDecisionStats } = await import('../src/store/history.js')
```

Then append:

```js
test('getDecisionStats returns by_tool, top_patterns, by_source', () => {
  const stats = getDecisionStats()
  assert.ok(Array.isArray(stats.by_tool), 'by_tool is array')
  assert.ok(Array.isArray(stats.top_patterns), 'top_patterns is array')
  assert.ok(typeof stats.by_source === 'object', 'by_source is object')
})

test('getDecisionStats by_tool has expected shape', () => {
  const stats = getDecisionStats()
  if (stats.by_tool.length > 0) {
    const row = stats.by_tool[0]
    assert.ok('tool' in row && 'total' in row && 'allow' in row)
  }
})
```

- [ ] **Step 8: Run tests — verify they pass**

```bash
node --test test/history.test.js
```

Expected: all tests PASS.

- [ ] **Step 9: Commit**

```bash
git add src/store/history.js test/history.test.js
git commit -m "feat: add listDecisions, getTodayStats, getDecisionStats to history store"
```

---

### Task 2: `getItemById` in `queue.js` and `getRule` in `rules.js`

**Files:**
- Modify: `src/store/queue.js` (append)
- Modify: `src/engine/rules.js` (append)
- Modify: `test/queue.test.js` (append)
- Modify: `test/rules.test.js` (append)

**Context:** `queue.js` uses `getDb` from `./db.js`. `rules.js` uses `getDb` from `../store/db.js`. Each test file sets its own `AFK_DB_DIR` env var before imports.

- [ ] **Step 1: Write failing test for `getItemById`**

Extend the existing import on lines 8-9 of `test/queue.test.js` — add `getItemById` to the destructuring:

```js
// lines 8-9 become:
const { enqueueDeferred, getPendingItems, resolveItem, getPendingCount, getItemById } =
  await import('../src/store/queue.js')
```

Then append the new tests:

```js
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
```

- [ ] **Step 2: Run test — verify it fails**

```bash
node --test test/queue.test.js
```

Expected: FAIL — `getItemById is not a function`.

- [ ] **Step 3: Implement `getItemById` in `src/store/queue.js`**

Append after `getPendingCount`:

```js
/**
 * Fetches a single deferred row by id.
 * @param {number} id
 * @returns {object|null} deferred row or null if not found
 */
export function getItemById(id) {
  const db = getDb()
  return db.prepare('SELECT * FROM deferred WHERE id = ?').get(id) ?? null
}
```

- [ ] **Step 4: Run test — verify it passes**

```bash
node --test test/queue.test.js
```

Expected: all tests PASS.

- [ ] **Step 5: Write failing test for `getRule`**

Extend the existing import on line 8 of `test/rules.test.js` — add `getRule` to the destructuring:

```js
// line 8 becomes:
const { matchRule, addRule, getRule } = await import('../src/engine/rules.js')
```

Then append the new tests:

```js
test('getRule returns rule by id', () => {
  const id = addRule({ tool: 'Bash', pattern: 'npm *', action: 'allow', label: 'npm' })
  const rule = getRule(id)
  assert.ok(rule !== null, 'rule found')
  assert.strictEqual(rule.id, id)
  assert.strictEqual(rule.tool, 'Bash')
  assert.strictEqual(rule.pattern, 'npm *')
})

test('getRule returns null for unknown id', () => {
  const rule = getRule('00000000-0000-0000-0000-000000000000')
  assert.strictEqual(rule, null)
})
```

- [ ] **Step 6: Run test — verify it fails**

```bash
node --test test/rules.test.js
```

Expected: FAIL — `getRule is not a function`.

- [ ] **Step 7: Implement `getRule` in `src/engine/rules.js`**

Append after `listRules`:

```js
/**
 * Fetches a single rule by id.
 * @param {string} id — uuid
 * @returns {object|null} rule row or null if not found
 */
export function getRule(id) {
  const db = getDb()
  return db.prepare('SELECT * FROM rules WHERE id = ?').get(id) ?? null
}
```

- [ ] **Step 8: Run all tests — verify nothing is broken**

```bash
node --test test/*.test.js
```

Expected: all 127+ tests PASS (plus the new ones).

- [ ] **Step 9: Commit**

```bash
git add src/store/queue.js src/engine/rules.js test/queue.test.js test/rules.test.js
git commit -m "feat: add getItemById to queue store and getRule to rules engine"
```

---

## Chunk 2: Server + REST API + Tests

### Task 3: Express server (`server.js`)

**Files:**
- Create: `src/dashboard/server.js`
- Create: `src/dashboard/api.js` (stub — just exports router for now)

**Context:** `server.js` binds to `127.0.0.1`. Tests will import `startServer(16789)` directly. The `src/dashboard/ui/` directory will be created in Task 5 — for now `server.js` just needs to serve it when it exists.

- [ ] **Step 1: Install express**

```bash
npm install express
```

Expected: `package.json` now lists `"express": "..."` under dependencies. No build step needed.

- [ ] **Step 2: Create stub `src/dashboard/api.js`**

```js
// src/dashboard/api.js
import express from 'express'

const router = express.Router()

router.get('/status', (_req, res) => {
  res.json({ ok: true })
})

export default router
```

- [ ] **Step 3: Create `src/dashboard/server.js`**

```js
// src/dashboard/server.js
import express from 'express'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import apiRouter from './api.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

let _server = null

/**
 * Starts the dashboard HTTP server bound to 127.0.0.1.
 * Idempotent — no-op if already running in this process.
 * @param {number} [port=6789]
 */
export function startServer(port = 6789) {
  if (_server) return
  const app = express()
  app.use(express.json())
  app.use('/api', apiRouter)
  app.use(express.static(join(__dirname, 'ui')))
  _server = createServer(app)
  _server.listen(port, '127.0.0.1', () => {
    // server running
  })
  _server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      process.stderr.write(`afk dashboard: port ${port} already in use\n`)
      _server = null
    } else {
      process.stderr.write(`afk dashboard error: ${err.message}\n`)
    }
  })
}

/**
 * Closes the server (used in tests for teardown).
 * @returns {Promise<void>}
 */
export function stopServer() {
  return new Promise(resolve => {
    if (!_server) return resolve()
    _server.close(() => { _server = null; resolve() })
  })
}

// Standalone mode: node src/dashboard/server.js
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startServer()
}
```

- [ ] **Step 4: Write a smoke test to verify server starts**

Create `test/dashboard.test.js`:

```js
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
  startServer(16789)
  // wait briefly for server to bind
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
```

- [ ] **Step 5: Run smoke test — verify it passes**

```bash
node --test test/dashboard.test.js
```

Expected: PASS — server starts and `/api/status` returns 200.

- [ ] **Step 6: Commit**

```bash
git add src/dashboard/server.js src/dashboard/api.js test/dashboard.test.js
git commit -m "feat: add Express dashboard server with stub API"
```

---

### Task 4: Full REST API + dashboard tests

**Files:**
- Modify: `src/dashboard/api.js` (replace stub with full implementation)
- Modify: `test/dashboard.test.js` (add all endpoint tests)

**Context:** **Prerequisite:** Chunk 1 (Tasks 1-2) must be complete before this task — `listDecisions`, `getTodayStats`, `getDecisionStats` (added to `history.js`), `getItemById` (added to `queue.js`), and `getRule` (added to `rules.js`) must already exist. All imports in `api.js` use relative paths from `src/dashboard/`. The store modules are at `../store/`, afk modules at `../afk/`, notify at `../notify/`, engine at `../engine/`.

Before writing the full API, seed the test DB with fixture data. Add seeding code to `test/dashboard.test.js` `before()` block.

- [ ] **Step 1: Update `before()` block in `test/dashboard.test.js` to seed fixture data**

Replace the `before()` call with:

```js
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

before(async () => {
  seed()
  startServer(16789)
  await new Promise(r => setTimeout(r, 100))
})
```

- [ ] **Step 2: Write all remaining endpoint tests in `test/dashboard.test.js`**

Append after the smoke test:

```js
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
```

- [ ] **Step 3: Run tests — expect failures (API not implemented yet)**

```bash
node --test test/dashboard.test.js
```

Expected: multiple failures since `api.js` is still a stub.

- [ ] **Step 4: Implement full `src/dashboard/api.js`**

```js
// src/dashboard/api.js
import express from 'express'
import { listDecisions, getTodayStats, getDecisionStats } from '../store/history.js'
import { getPendingItems, getPendingCount, resolveItem, getItemById } from '../store/queue.js'
import { addRule, removeRule, listRules, getRule } from '../engine/rules.js'
import { getState, setAfk } from '../afk/state.js'
import { buildDigest } from '../afk/digest.js'
import { loadConfig } from '../notify/config.js'
import { notify } from '../notify/notify.js'

const router = express.Router()

// ── GET /api/status ──────────────────────────────────────────────────────────
router.get('/status', (_req, res) => {
  const state = getState()
  const today = getTodayStats()
  const queue_count = getPendingCount()
  const auto_rate = today.total > 0
    ? Math.round(today.auto_approved / today.total * 100)
    : 0
  res.json({
    afk:         state.afk,
    afk_since:   state.afk_since  ?? null,
    afk_until:   state.afk_until  ?? null,
    session_id:  state.session_id ?? null,
    project_cwd: process.cwd(),
    queue_count,
    today: { ...today, auto_rate }
  })
})

// ── GET /api/decisions ────────────────────────────────────────────────────────
router.get('/decisions', (req, res) => {
  const { page, limit, tool, source, decision, date } = req.query
  const result = listDecisions({
    page:     page     ? Number(page)  : 1,
    limit:    limit    ? Number(limit) : 50,
    tool:     tool     || undefined,
    source:   source   || undefined,
    decision: decision || undefined,
    date:     date     || undefined
  })
  res.json(result)
})

// ── GET /api/queue ────────────────────────────────────────────────────────────
router.get('/queue', (_req, res) => {
  res.json(getPendingItems())
})

// ── POST /api/queue/:id ───────────────────────────────────────────────────────
router.post('/queue/:id', async (req, res) => {
  const { action } = req.body ?? {}
  if (action !== 'allow' && action !== 'deny') {
    return res.status(400).json({ error: 'invalid action — must be allow or deny' })
  }
  const id = Number(req.params.id)
  const row = getItemById(id)
  resolveItem(id, action)
  // fire-and-forget notification
  try {
    const config = loadConfig()
    if (config?.notifications?.provider) {
      notify(config, {
        tool:      row?.tool      ?? 'unknown',
        command:   row?.command   ?? null,
        path:      row?.path      ?? null,
        requestId: String(id)
      }, Date.now() + (config.notifications?.timeout ?? 5) * 1000).catch(err => process.stderr.write(`afk notify: ${err.message}\n`))
    }
  } catch { /* ignore notify errors */ }
  res.json({ id, final: action, review_ts: Date.now() })
})

// ── GET /api/rules ────────────────────────────────────────────────────────────
router.get('/rules', (_req, res) => {
  res.json(listRules(null))
})

// ── POST /api/rules ───────────────────────────────────────────────────────────
router.post('/rules', (req, res) => {
  const { tool, pattern, action, label, project, priority } = req.body ?? {}
  for (const field of ['tool', 'pattern', 'action']) {
    if (!req.body?.[field]) {
      return res.status(400).json({ error: `missing field: ${field}` })
    }
  }
  const id = addRule({ tool, pattern, action, label, project, priority })
  res.json(getRule(id))
})

// ── DELETE /api/rules/:id ─────────────────────────────────────────────────────
router.delete('/rules/:id', (req, res) => {
  removeRule(req.params.id)
  res.json({ deleted: true })
})

// ── GET /api/stats ────────────────────────────────────────────────────────────
router.get('/stats', (_req, res) => {
  res.json(getDecisionStats())
})

// ── GET /api/digest ───────────────────────────────────────────────────────────
router.get('/digest', (_req, res) => {
  const state = getState()
  const entries = state.digest ?? []
  const pendingCount = getPendingCount()
  res.json({ digest: buildDigest(entries, pendingCount) })
})

// ── POST /api/afk ─────────────────────────────────────────────────────────────
router.post('/afk', (req, res) => {
  const { on, duration } = req.body ?? {}
  setAfk(Boolean(on), duration ?? undefined)
  res.json(getState())
})

// ── GET /api/export ───────────────────────────────────────────────────────────
router.get('/export', (req, res) => {
  const format = req.query.format === 'csv' ? 'csv' : 'json'
  const { items } = listDecisions({ limit: 10000 })
  if (format === 'csv') {
    res.setHeader('Content-Disposition', 'attachment; filename="afk-decisions.csv"')
    res.setHeader('Content-Type', 'text/csv')
    const header = 'id,ts,tool,command,path,decision,source,confidence'
    const rows = items.map(i =>
      [i.id, i.ts, i.tool, i.command ?? '', i.path ?? '', i.decision, i.source, i.confidence ?? ''].join(',')
    )
    res.send([header, ...rows].join('\n'))
  } else {
    res.setHeader('Content-Disposition', 'attachment; filename="afk-decisions.json"')
    res.json(items)
  }
})

export default router
```

- [ ] **Step 5: Run dashboard tests**

```bash
node --test test/dashboard.test.js
```

Expected: all tests PASS.

- [ ] **Step 6: Run full test suite — verify nothing broken**

```bash
node --test test/*.test.js
```

Expected: all 127+ tests PASS (new tests added).

- [ ] **Step 7: Commit**

```bash
git add src/dashboard/api.js test/dashboard.test.js
git commit -m "feat: implement full REST API for dashboard with tests"
```

---

## Chunk 3: UI — Shell, Style, Overview, Queue

### Task 5: HTML shell + CSS theme

**Files:**
- Create: `src/dashboard/ui/index.html`
- Create: `src/dashboard/ui/style.css`

**Context:** No CDN dependencies. No bundler. Plain HTML5 + CSS variables. Sidebar is `140px` wide, fixed left. Main content area fills the rest.

- [ ] **Step 1: Create `src/dashboard/ui/index.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AFK Dashboard</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <div class="layout">
    <nav class="sidebar">
      <div class="sidebar-logo">⚡ AFK</div>
      <a href="#overview" class="nav-link" data-page="overview">● Overview</a>
      <a href="#queue"    class="nav-link" data-page="queue">▣ Queue <span class="badge" id="queue-badge"></span></a>
      <a href="#history"  class="nav-link" data-page="history">≡ History</a>
      <a href="#patterns" class="nav-link" data-page="patterns">◈ Patterns</a>
      <a href="#rules"    class="nav-link" data-page="rules">⚙ Rules</a>
      <a href="#digest"   class="nav-link" data-page="digest">📋 Digest</a>
    </nav>
    <main id="content" class="main-content">
      <p class="loading">Loading...</p>
    </main>
  </div>
  <script src="app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create `src/dashboard/ui/style.css`**

```css
/* ── Reset & Variables ─────────────────────────────────────────────────────── */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  --bg:        #0a0a14;
  --sidebar:   #0d0d1a;
  --card:      #0d0d1a;
  --border:    #1e1e3a;
  --text:      #e0e0f0;
  --muted:     #666;
  --accent:    #7b8cde;
  --allow:     #2ecc71;
  --deny:      #e74c3c;
  --warn:      #e8a838;
  --sidebar-w: 140px;
}

body { background: var(--bg); color: var(--text); font-family: system-ui, sans-serif; font-size: 14px; }

/* ── Layout ────────────────────────────────────────────────────────────────── */
.layout { display: flex; min-height: 100vh; }
.sidebar {
  width: var(--sidebar-w);
  flex-shrink: 0;
  background: var(--sidebar);
  border-right: 1px solid var(--border);
  padding: 16px 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.main-content { flex: 1; padding: 24px; overflow-y: auto; }

/* ── Sidebar ───────────────────────────────────────────────────────────────── */
.sidebar-logo { color: var(--accent); font-weight: 700; font-size: 15px; margin-bottom: 16px; padding: 0 8px; }
.nav-link {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-radius: 5px;
  color: var(--muted);
  text-decoration: none;
  font-size: 13px;
  transition: color .15s, background .15s;
}
.nav-link:hover  { color: var(--text); background: var(--border); }
.nav-link.active { color: var(--text); background: var(--border); }
.badge {
  margin-left: auto;
  background: var(--deny);
  color: #fff;
  border-radius: 9px;
  padding: 1px 5px;
  font-size: 10px;
  display: none;
}
.badge.visible { display: inline; }

/* ── Typography ────────────────────────────────────────────────────────────── */
h2 { font-size: 18px; font-weight: 600; color: var(--accent); margin-bottom: 16px; }
h3 { font-size: 14px; font-weight: 600; margin-bottom: 8px; }
.muted { color: var(--muted); }
.loading { color: var(--muted); }

/* ── Cards ─────────────────────────────────────────────────────────────────── */
.card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 14px;
}
.stats-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 20px; }
.stat-card { background: var(--card); border: 1px solid var(--border); border-radius: 6px; padding: 12px; }
.stat-label { color: var(--muted); font-size: 10px; text-transform: uppercase; letter-spacing: .5px; margin-bottom: 4px; }
.stat-value { font-size: 22px; font-weight: 700; }
.stat-sub   { color: var(--muted); font-size: 11px; margin-top: 2px; }
.stat-value.green { color: var(--allow); }
.stat-value.red   { color: var(--deny);  }
.stat-value.blue  { color: var(--accent); }

/* ── Badges ─────────────────────────────────────────────────────────────────── */
.badge-tool   { background: #1a1a3a; color: var(--accent); border-radius: 4px; padding: 2px 7px; font-size: 11px; font-weight: 600; }
.badge-allow  { background: #0f2a0f; color: var(--allow);  border-radius: 4px; padding: 2px 7px; font-size: 11px; }
.badge-deny   { background: #2a0f0f; color: var(--deny);   border-radius: 4px; padding: 2px 7px; font-size: 11px; }
.badge-defer  { background: #2a1a00; color: var(--warn);   border-radius: 4px; padding: 2px 7px; font-size: 11px; }
.badge-ask    { background: #1a1a2a; color: var(--muted);  border-radius: 4px; padding: 2px 7px; font-size: 11px; }
.badge-source { background: #1a1a2e; color: var(--muted);  border-radius: 4px; padding: 2px 7px; font-size: 11px; }

/* ── Buttons ────────────────────────────────────────────────────────────────── */
button, .btn {
  border: 1px solid var(--border);
  background: var(--card);
  color: var(--text);
  padding: 5px 12px;
  border-radius: 5px;
  font-size: 13px;
  cursor: pointer;
}
button:hover, .btn:hover { border-color: var(--accent); color: var(--accent); }
.btn-allow { background: #0f2a0f; border-color: #1a4a1a; color: var(--allow); }
.btn-allow:hover { background: #1a3a1a; }
.btn-deny  { background: #2a0f0f; border-color: #4a1a1a; color: var(--deny);  }
.btn-deny:hover  { background: #3a1a1a; }
button:disabled, .btn:disabled { opacity: .4; cursor: not-allowed; }

/* ── Inputs ─────────────────────────────────────────────────────────────────── */
input, select {
  background: var(--bg);
  border: 1px solid var(--border);
  color: var(--text);
  padding: 5px 10px;
  border-radius: 5px;
  font-size: 13px;
}
input:focus, select:focus { outline: none; border-color: var(--accent); }

/* ── Tables ─────────────────────────────────────────────────────────────────── */
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th { color: var(--muted); font-size: 10px; text-transform: uppercase; letter-spacing: .5px; padding: 6px 10px; text-align: left; border-bottom: 1px solid var(--border); }
td { padding: 8px 10px; border-bottom: 1px solid var(--border); vertical-align: middle; }
tr:last-child td { border-bottom: none; }
.mono { font-family: monospace; font-size: 12px; color: var(--warn); }

/* ── AFK Toggle ─────────────────────────────────────────────────────────────── */
.afk-row {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 12px 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 20px;
}
.afk-status-on  { color: var(--allow); font-weight: 700; }
.afk-status-off { color: var(--deny);  font-weight: 700; }

/* ── Queue items ────────────────────────────────────────────────────────────── */
.queue-item {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 12px;
  margin-bottom: 10px;
  transition: opacity .3s;
}
.queue-item.fading { opacity: 0; }
.queue-item-header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.queue-item-cmd    { font-family: monospace; color: var(--warn); background: #111; border-radius: 4px; padding: 4px 8px; font-size: 12px; margin-bottom: 8px; }
.queue-item-meta   { color: var(--muted); font-size: 11px; margin-bottom: 8px; }
.queue-item-actions { display: flex; gap: 8px; }
.queue-item-actions button { flex: 1; }

/* ── Filter bar ─────────────────────────────────────────────────────────────── */
.filter-bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 16px; }

/* ── Pagination ─────────────────────────────────────────────────────────────── */
.pagination { display: flex; gap: 8px; align-items: center; margin-top: 16px; }

/* ── Bar chart ──────────────────────────────────────────────────────────────── */
.bar-row { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
.bar-label { width: 100px; font-size: 12px; color: var(--muted); }
.bar-track { flex: 1; background: var(--border); border-radius: 3px; height: 10px; overflow: hidden; }
.bar-fill  { height: 100%; border-radius: 3px; background: var(--allow); }
.bar-value { width: 40px; font-size: 11px; text-align: right; color: var(--muted); }

/* ── Rate bar (patterns table) ──────────────────────────────────────────────── */
.rate-bar { display: flex; height: 10px; border-radius: 3px; overflow: hidden; width: 80px; }
.rate-green { background: var(--allow); }
.rate-red   { background: var(--deny); }

/* ── Digest pre ─────────────────────────────────────────────────────────────── */
.digest-pre {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 16px;
  font-family: monospace;
  font-size: 13px;
  white-space: pre-wrap;
  line-height: 1.6;
}

/* ── Inline form ────────────────────────────────────────────────────────────── */
.inline-form { background: var(--card); border: 1px solid var(--border); border-radius: 6px; padding: 16px; margin-top: 12px; }
.form-row { display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-end; margin-bottom: 10px; }
.form-field { display: flex; flex-direction: column; gap: 4px; }
.form-field label { font-size: 11px; color: var(--muted); }

/* ── Error ──────────────────────────────────────────────────────────────────── */
.error-msg { color: var(--deny); background: #2a0f0f; border: 1px solid #4a1a1a; border-radius: 5px; padding: 10px 14px; margin-bottom: 12px; }

/* ── Recent decisions ───────────────────────────────────────────────────────── */
.recent-row { display: flex; align-items: center; gap: 10px; padding: 7px 0; border-bottom: 1px solid var(--border); font-size: 13px; }
.recent-row:last-child { border-bottom: none; }
.recent-icon { font-size: 14px; width: 20px; text-align: center; }
.recent-cmd  { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font-family: monospace; font-size: 12px; }
.recent-time { color: var(--muted); font-size: 11px; flex-shrink: 0; }
```

- [ ] **Step 3: Run full test suite — verify all existing tests still pass**

```bash
node --test test/*.test.js
```

Expected: all existing tests PASS. (UI files are static and not covered by automated tests — they're exercised by the `test/dashboard.test.js` API tests.)

- [ ] **Step 4: Commit**

```bash
git add src/dashboard/ui/index.html src/dashboard/ui/style.css
git commit -m "feat: dashboard UI shell and dark navy CSS theme"
```

---

### Task 6: `app.js` — router + Overview + Queue pages

**Files:**
- Create: `src/dashboard/ui/app.js`

**Context:** Vanilla ES6, no modules (loaded as plain `<script>` in index.html — not `type="module"` since we serve as static files). All functions are global. `apiFetch` handles errors. `_refreshInterval` clears on every page render.

- [ ] **Step 1: Create `src/dashboard/ui/app.js` with router + Overview + Queue**

```js
// src/dashboard/ui/app.js

let _refreshInterval = null
let _projectCwd = null   // populated from /api/status for project-scoped rule creation

// ── Router ────────────────────────────────────────────────────────────────────
const routes = {
  overview: renderOverview,
  queue:    renderQueue,
  history:  renderHistory,
  patterns: renderPatterns,
  rules:    renderRules,
  digest:   renderDigest
}

function navigate() {
  const hash = (location.hash || '#overview').replace('#', '')
  const page = routes[hash] ? hash : 'overview'
  clearInterval(_refreshInterval)
  document.querySelectorAll('.nav-link').forEach(a => {
    a.classList.toggle('active', a.dataset.page === page)
  })
  routes[page]()
}

window.addEventListener('hashchange', navigate)
window.addEventListener('load', navigate)

// ── API fetch ─────────────────────────────────────────────────────────────────
async function apiFetch(path, opts = {}) {
  try {
    const res = await fetch('/api' + path, opts)
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }))
      throw new Error(err.error || res.statusText)
    }
    return res.json()
  } catch (e) {
    document.getElementById('content').innerHTML =
      `<p class="error-msg">Error: ${e.message}</p>`
    throw e
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60)  return `${s}s ago`
  if (s < 3600) return `${Math.floor(s/60)}m ago`
  if (s < 86400) return `${Math.floor(s/3600)}h ago`
  return `${Math.floor(s/86400)}d ago`
}

function fmtTs(ts) {
  const d = new Date(ts)
  return d.getUTCFullYear() + '-' +
    String(d.getUTCMonth()+1).padStart(2,'0') + '-' +
    String(d.getUTCDate()).padStart(2,'0') + ' ' +
    String(d.getUTCHours()).padStart(2,'0') + ':' +
    String(d.getUTCMinutes()).padStart(2,'0')
}

function decisionBadge(d) {
  const cls = { allow:'allow', deny:'deny', defer:'defer', ask:'ask' }[d] || 'ask'
  return `<span class="badge-${cls}">${d}</span>`
}

function updateQueueBadge(count) {
  const el = document.getElementById('queue-badge')
  if (!el) return
  el.textContent = count
  el.classList.toggle('visible', count > 0)
}

// ── Overview ──────────────────────────────────────────────────────────────────
async function renderOverview() {
  clearInterval(_refreshInterval)
  const [status, recent] = await Promise.all([
    apiFetch('/status'),
    apiFetch('/decisions?limit=10')
  ]).catch(() => [null, null])
  if (!status) return

  updateQueueBadge(status.queue_count)

  const afkLabel  = status.afk ? '● ON'  : '● OFF'
  const afkCls    = status.afk ? 'afk-status-on' : 'afk-status-off'
  const btnLabel  = status.afk ? 'Disable AFK' : 'Enable AFK'
  const t = status.today

  const recentRows = (recent?.items || []).map(i => {
    const icon = i.decision === 'allow' ? '✓' : i.decision === 'deny' ? '✗' : '⏸'
    const cmd = (i.command || i.path || i.tool).slice(0, 50)
    return `<div class="recent-row">
      <span class="recent-icon">${icon}</span>
      <span class="badge-tool">${i.tool}</span>
      <span class="recent-cmd">${cmd}</span>
      <span class="recent-time">${timeAgo(i.ts)}</span>
    </div>`
  }).join('')

  document.getElementById('content').innerHTML = `
    <h2>Overview</h2>
    <div class="afk-row">
      <div>
        <div class="muted" style="font-size:10px;text-transform:uppercase;margin-bottom:3px">AFK Mode</div>
        <div class="${afkCls}">${afkLabel}</div>
      </div>
      <button onclick="toggleAfk(${!status.afk})">${btnLabel}</button>
    </div>
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">Auto-approved</div>
        <div class="stat-value green">${t.auto_approved}</div>
        <div class="stat-sub">today</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Deferred</div>
        <div class="stat-value red" style="cursor:pointer" onclick="location.hash='#queue'">${status.queue_count}</div>
        <div class="stat-sub">pending review</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Auto-rate</div>
        <div class="stat-value blue">${t.auto_rate}%</div>
        <div class="stat-sub">this session</div>
      </div>
    </div>
    <h3>Recent Decisions</h3>
    <div class="card">${recentRows || '<p class="muted">No decisions yet.</p>'}</div>
  `
}

async function toggleAfk(on) {
  await apiFetch('/afk', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ on })
  }).catch(() => null)
  renderOverview()
}

// ── Queue ─────────────────────────────────────────────────────────────────────
async function renderQueue() {
  clearInterval(_refreshInterval)
  const items = await apiFetch('/queue').catch(() => null)
  if (!items) return

  updateQueueBadge(items.length)

  if (items.length === 0) {
    document.getElementById('content').innerHTML = `
      <h2>Queue</h2>
      <p class="muted">No pending items.</p>
    `
    return
  }

  const cards = items.map(item => {
    const cmd = item.command || item.path || item.tool
    const ts = fmtTs(item.ts)
    return `<div class="queue-item" id="qi-${item.id}">
      <div class="queue-item-header">
        <span class="badge-tool">${item.tool}</span>
        <span class="muted" style="font-size:11px">${ts}</span>
      </div>
      <div class="queue-item-cmd">${cmd}</div>
      <div class="queue-item-meta">${item.session_id}</div>
      <div class="queue-item-actions">
        <button class="btn-allow" onclick="reviewItem(${item.id},'allow')">✓ Allow</button>
        <button class="btn-deny"  onclick="reviewItem(${item.id},'deny')">✗ Deny</button>
      </div>
    </div>`
  }).join('')

  document.getElementById('content').innerHTML = `
    <h2>Queue <span class="muted" style="font-size:14px">${items.length} pending</span></h2>
    <div style="margin-bottom:12px">
      <button onclick="approveAll()">Approve All</button>
    </div>
    <div id="queue-list">${cards}</div>
    <p id="queue-error" class="error-msg" style="display:none"></p>
  `
}

async function reviewItem(id, action) {
  const el = document.getElementById(`qi-${id}`)
  if (el) { el.classList.add('fading'); await new Promise(r => setTimeout(r, 300)) }
  await apiFetch(`/queue/${id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action })
  }).catch(() => null)
  if (el) el.remove()
  // update badge
  const remaining = document.querySelectorAll('.queue-item').length
  updateQueueBadge(remaining)
  if (remaining === 0) {
    document.getElementById('queue-list').innerHTML = '<p class="muted">No pending items.</p>'
  }
}

async function approveAll() {
  const items = document.querySelectorAll('.queue-item')
  const allBtns = document.querySelectorAll('.queue-item-actions button, button[onclick="approveAll()"]')
  allBtns.forEach(b => b.disabled = true)
  const errEl = document.getElementById('queue-error')
  for (const item of items) {
    const id = item.id.replace('qi-', '')
    try {
      await apiFetch(`/queue/${id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'allow' })
      })
      item.classList.add('fading')
      await new Promise(r => setTimeout(r, 300))
      item.remove()
      updateQueueBadge(document.querySelectorAll('.queue-item').length)
    } catch (e) {
      errEl.textContent = `Error approving item ${id}: ${e.message}`
      errEl.style.display = 'block'
      allBtns.forEach(b => b.disabled = false)
      return
    }
  }
  document.getElementById('queue-list').innerHTML = '<p class="muted">No pending items.</p>'
  updateQueueBadge(0)
}

// ── History ───────────────────────────────────────────────────────────────────
async function renderHistory() {
  clearInterval(_refreshInterval)
  document.getElementById('content').innerHTML = `
    <h2>History</h2>
    <div class="filter-bar">
      <select id="f-tool" onchange="loadHistory(1)">
        <option value="">All tools</option>
        <option>Bash</option><option>Read</option><option>Write</option>
        <option>Edit</option><option>Glob</option><option>Grep</option>
      </select>
      <select id="f-source" onchange="loadHistory(1)">
        <option value="">All sources</option>
        <option>user</option><option>rule</option>
        <option>prediction</option><option>auto_afk</option><option>auto_defer</option>
      </select>
      <input id="f-date" type="date" onchange="loadHistory(1)" placeholder="Date (UTC)">
      <button onclick="clearFilters()">Clear</button>
    </div>
    <div id="history-table"></div>
    <div class="pagination" id="history-pager"></div>
  `
  await loadHistory(1)
}

let _historyPage = 1
async function loadHistory(page) {
  _historyPage = page
  const tool   = document.getElementById('f-tool')?.value   || ''
  const source = document.getElementById('f-source')?.value || ''
  const date   = document.getElementById('f-date')?.value   || ''
  const params = new URLSearchParams({ page, limit: 50 })
  if (tool)   params.set('tool', tool)
  if (source) params.set('source', source)
  if (date)   params.set('date', date)
  const data = await apiFetch('/decisions?' + params).catch(() => null)
  if (!data) return

  const rows = data.items.map(i => {
    const cmd = (i.command || i.path || '—').slice(0, 40)
    const conf = i.confidence != null ? Math.round(i.confidence * 100) + '%' : '—'
    return `<tr>
      <td class="muted">${fmtTs(i.ts)}</td>
      <td><span class="badge-tool">${i.tool}</span></td>
      <td class="mono">${cmd}</td>
      <td>${decisionBadge(i.decision)}</td>
      <td><span class="badge-source">${i.source}</span></td>
      <td class="muted">${conf}</td>
    </tr>`
  }).join('')

  document.getElementById('history-table').innerHTML = `
    <table>
      <thead><tr><th>Time</th><th>Tool</th><th>Command/Path</th><th>Decision</th><th>Source</th><th>Conf</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="6" class="muted">No results.</td></tr>'}</tbody>
    </table>
  `
  document.getElementById('history-pager').innerHTML = `
    <button onclick="loadHistory(${page-1})" ${page <= 1 ? 'disabled' : ''}>← Prev</button>
    <span class="muted">Page ${data.page} of ${data.pages}</span>
    <button onclick="loadHistory(${page+1})" ${page >= data.pages ? 'disabled' : ''}>Next →</button>
  `
}

function clearFilters() {
  document.getElementById('f-tool').value   = ''
  document.getElementById('f-source').value = ''
  document.getElementById('f-date').value   = ''
  loadHistory(1)
}

// ── Patterns ──────────────────────────────────────────────────────────────────
async function renderPatterns() {
  clearInterval(_refreshInterval)
  const stats = await apiFetch('/stats').catch(() => null)
  if (!stats) return

  const patternRows = stats.top_patterns.map(p => {
    const pct = Math.round((p.allow_rate || 0) * 100)
    return `<tr>
      <td><span class="badge-tool">${p.tool}</span></td>
      <td class="mono">${p.pattern.slice(0, 50)}</td>
      <td class="muted">${p.total}</td>
      <td>
        <div class="rate-bar">
          <div class="rate-green" style="width:${pct}%"></div>
          <div class="rate-red"   style="width:${100-pct}%"></div>
        </div>
      </td>
      <td class="muted">${pct}%</td>
    </tr>`
  }).join('')

  const sourceRows = Object.entries(stats.by_source).map(([src, count]) => {
    const total = Object.values(stats.by_source).reduce((a,b) => a+b, 0)
    const pct = total > 0 ? Math.round(count / total * 100) : 0
    return `<div class="bar-row">
      <div class="bar-label">${src}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
      <div class="bar-value">${count}</div>
    </div>`
  }).join('')

  document.getElementById('content').innerHTML = `
    <h2>Patterns</h2>
    <h3>Top Patterns (last 90 days)</h3>
    <div class="card" style="margin-bottom:20px">
      <table>
        <thead><tr><th>Tool</th><th>Pattern</th><th>Count</th><th>Approval Rate</th><th></th></tr></thead>
        <tbody>${patternRows || '<tr><td colspan="5" class="muted">No data yet.</td></tr>'}</tbody>
      </table>
    </div>
    <h3>By Source</h3>
    <div class="card">${sourceRows || '<p class="muted">No data yet.</p>'}</div>
  `
}

// ── Rules ─────────────────────────────────────────────────────────────────────
async function renderRules() {
  clearInterval(_refreshInterval)
  const [rules, status] = await Promise.all([
    apiFetch('/rules').catch(() => null),
    apiFetch('/status').catch(() => null)
  ])
  if (!rules) return
  _projectCwd = status?.project_cwd ?? null

  const rows = rules.map(r => {
    const scope = r.project ? r.project.split('/').pop() : 'global'
    const created = fmtTs(r.created_ts)
    return `<tr>
      <td class="muted">${r.priority}</td>
      <td><span class="badge-tool">${r.tool}</span></td>
      <td class="mono">${r.pattern}</td>
      <td>${decisionBadge(r.action)}</td>
      <td>${r.label || '—'}</td>
      <td class="muted">${scope}</td>
      <td class="muted">${created}</td>
      <td><button onclick="deleteRule('${r.id}')">✕</button></td>
    </tr>`
  }).join('')

  document.getElementById('content').innerHTML = `
    <h2>Rules</h2>
    <div style="margin-bottom:12px">
      <button onclick="toggleAddForm()">+ Add Rule</button>
    </div>
    <div id="add-rule-form" class="inline-form" style="display:none">
      <div class="form-row">
        <div class="form-field">
          <label>Tool</label>
          <select id="r-tool">
            <option>Bash</option><option>Read</option><option>Write</option>
            <option>Edit</option><option>Glob</option><option>Grep</option><option>*</option>
          </select>
        </div>
        <div class="form-field">
          <label>Pattern</label>
          <input id="r-pattern" placeholder="npm *" style="width:200px">
        </div>
        <div class="form-field">
          <label>Action</label>
          <select id="r-action"><option>allow</option><option>deny</option></select>
        </div>
        <div class="form-field">
          <label>Label</label>
          <input id="r-label" placeholder="optional label" style="width:160px">
        </div>
        <div class="form-field">
          <label>Scope</label>
          <select id="r-scope"><option value="">global</option><option value="cwd">this project</option></select>
        </div>
        <div class="form-field">
          <label>Priority</label>
          <input id="r-priority" type="number" value="0" style="width:70px">
        </div>
      </div>
      <div style="display:flex;gap:8px">
        <button onclick="saveRule()">Save</button>
        <button onclick="toggleAddForm()">Cancel</button>
      </div>
      <p id="rule-error" class="error-msg" style="display:none"></p>
    </div>
    <div class="card">
      <table>
        <thead><tr><th>Pri</th><th>Tool</th><th>Pattern</th><th>Action</th><th>Label</th><th>Scope</th><th>Created</th><th></th></tr></thead>
        <tbody id="rules-tbody">${rows || '<tr><td colspan="8" class="muted">No rules yet.</td></tr>'}</tbody>
      </table>
    </div>
  `
}

function toggleAddForm() {
  const f = document.getElementById('add-rule-form')
  f.style.display = f.style.display === 'none' ? 'block' : 'none'
}

async function saveRule() {
  const tool     = document.getElementById('r-tool').value
  const pattern  = document.getElementById('r-pattern').value.trim()
  const action   = document.getElementById('r-action').value
  const label    = document.getElementById('r-label').value.trim() || undefined
  const scopeVal = document.getElementById('r-scope').value
  const project  = scopeVal === 'cwd' ? (_projectCwd ?? undefined) : undefined
  const priority = Number(document.getElementById('r-priority').value) || 0
  const errEl    = document.getElementById('rule-error')
  errEl.style.display = 'none'
  if (!pattern) { errEl.textContent = 'Pattern is required.'; errEl.style.display = 'block'; return }
  await apiFetch('/rules', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tool, pattern, action, label, project, priority })
  }).catch(e => { errEl.textContent = e.message; errEl.style.display = 'block' })
  renderRules()
}

async function deleteRule(id) {
  await apiFetch(`/rules/${id}`, { method: 'DELETE' }).catch(() => null)
  renderRules()
}

// ── Digest ────────────────────────────────────────────────────────────────────
async function renderDigest() {
  clearInterval(_refreshInterval)
  document.getElementById('content').innerHTML = `
    <h2>Digest</h2>
    <div id="digest-content"><p class="muted">Loading...</p></div>
  `
  await fetchAndRenderDigest()
  const status = await apiFetch('/status').catch(() => null)
  if (status?.afk) {
    _refreshInterval = setInterval(fetchAndRenderDigest, 30000)
  }
}

async function fetchAndRenderDigest() {
  const data = await apiFetch('/digest').catch(() => null)
  const el = document.getElementById('digest-content')
  if (!el || !data) return
  el.innerHTML = `<pre class="digest-pre">${data.digest}</pre>`
}
```

- [ ] **Step 2: Run full test suite — all tests still pass**

```bash
node --test test/*.test.js
```

Expected: all tests PASS.

- [ ] **Step 3: Commit**

```bash
git add src/dashboard/ui/app.js
git commit -m "feat: dashboard UI — all 6 pages (overview, queue, history, patterns, rules, digest)"
```

---

## Chunk 4: CLI Scripts + Slash Commands

### Task 7: `afk-review-cli.js` + `commands/afk-review.md`

**Files:**
- Create: `scripts/afk-review-cli.js`
- Create: `commands/afk-review.md`

**Context:** The server must be started as a detached subprocess so it survives after the CLI process exits. Detect if port 6789 is already in use with a TCP probe before spawning.

- [ ] **Step 1: Create `scripts/afk-review-cli.js`**

```js
#!/usr/bin/env node
// scripts/afk-review-cli.js
import { spawn, execSync } from 'node:child_process'
import { createConnection } from 'node:net'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const serverScript = resolve(__dirname, '../src/dashboard/server.js')
const PORT = 6789

function isPortInUse(port) {
  return new Promise(resolve => {
    const conn = createConnection(port, '127.0.0.1')
    conn.on('connect', () => { conn.destroy(); resolve(true) })
    conn.on('error', () => resolve(false))
  })
}

const alreadyRunning = await isPortInUse(PORT)
if (!alreadyRunning) {
  const child = spawn(process.execPath, [serverScript], {
    detached: true,
    stdio: 'ignore'
  })
  child.unref()
  // brief pause to let server bind
  await new Promise(r => setTimeout(r, 300))
}

const url = `http://localhost:${PORT}`
const cmd = process.platform === 'darwin' ? `open "${url}"`
          : process.platform === 'win32'  ? `start "${url}"`
          : `xdg-open "${url}"`
try {
  execSync(cmd)
  console.log(`Dashboard: ${url}`)
} catch {
  console.log(`Dashboard running at: ${url}`)
}
```

- [ ] **Step 2: Create `commands/afk-review.md`**

```markdown
---
name: afk:review
description: Open the AFK web dashboard in your browser (starts server if needed).
---

Start the dashboard server and open it in the browser:

```bash
SCRIPT="${PLUGIN_DIR}/scripts/afk-review-cli.js"
if [ -z "$PLUGIN_DIR" ] || [ ! -f "$SCRIPT" ]; then
  SCRIPT="$(git rev-parse --show-toplevel 2>/dev/null)/scripts/afk-review-cli.js"
fi
node "$SCRIPT"
```

Read the output and report the URL to the user.
The dashboard shows decision history, deferred queue, patterns, rules, and session digest.
```

- [ ] **Step 3: Manually test**

```bash
node scripts/afk-review-cli.js
```

Expected: browser opens at `http://localhost:6789` (or URL is printed if browser open fails). Process exits immediately; server keeps running. Verify server is up: `curl http://localhost:6789/api/status`.

- [ ] **Step 4: Commit**

```bash
git add scripts/afk-review-cli.js commands/afk-review.md
git commit -m "feat: /afk:review command — detached server spawn + browser open"
```

---

### Task 8: `afk-stats-cli.js` + `commands/afk-stats.md`

**Files:**
- Create: `scripts/afk-stats-cli.js`
- Create: `commands/afk-stats.md`

- [ ] **Step 1: Create `scripts/afk-stats-cli.js`**

```js
#!/usr/bin/env node
// scripts/afk-stats-cli.js
import { getTodayStats, getDecisionStats } from '../src/store/history.js'
import { getPendingCount } from '../src/store/queue.js'
import { isAfk } from '../src/afk/state.js'

const today   = getTodayStats()
const stats   = getDecisionStats()
const pending = getPendingCount()
const afkOn   = isAfk()

const userReviewed = today.total - today.auto_approved - today.auto_denied - today.deferred
const autoRate     = today.total > 0 ? Math.round(today.auto_approved / today.total * 100) : 0
const denyRate     = today.total > 0 ? Math.round(today.auto_denied   / today.total * 100) : 0

console.log('\nAFK Stats — today')
console.log(`  Total requests:    ${today.total}`)
console.log(`  Auto-approved:     ${today.auto_approved} (${autoRate}%)`)
console.log(`  Auto-denied:       ${today.auto_denied} (${denyRate}%)`)
console.log(`  User-reviewed:     ${Math.max(0, userReviewed)}`)
console.log(`  Deferred (queue):  ${pending} pending`)
console.log(`  AFK mode:          ${afkOn ? 'ON' : 'OFF'}`)

const top3 = stats.top_patterns.slice(0, 3)
if (top3.length > 0) {
  console.log('\nTop auto-approved patterns:')
  top3.forEach((p, i) => {
    console.log(`  ${i+1}. ${p.tool}: ${p.pattern}`)
  })
}
console.log()
```

- [ ] **Step 2: Create `commands/afk-stats.md`**

```markdown
---
name: afk:stats
description: Show today's AFK decision summary in the terminal.
---

```bash
SCRIPT="${PLUGIN_DIR}/scripts/afk-stats-cli.js"
if [ -z "$PLUGIN_DIR" ] || [ ! -f "$SCRIPT" ]; then
  SCRIPT="$(git rev-parse --show-toplevel 2>/dev/null)/scripts/afk-stats-cli.js"
fi
node "$SCRIPT"
```

Read the output and present it clearly to the user.
```

- [ ] **Step 3: Manually test**

```bash
node scripts/afk-stats-cli.js
```

Expected: formatted stats printed to terminal (most counts will be 0 on a fresh DB).

- [ ] **Step 4: Commit**

```bash
git add scripts/afk-stats-cli.js commands/afk-stats.md
git commit -m "feat: /afk:stats command — terminal stats summary"
```

---

### Task 9: `afk-rules-cli.js` + `commands/afk-rules.md`

**Files:**
- Create: `scripts/afk-rules-cli.js`
- Create: `commands/afk-rules.md`

- [ ] **Step 1: Create `scripts/afk-rules-cli.js`**

```js
#!/usr/bin/env node
// scripts/afk-rules-cli.js
import { listRules, addRule, removeRule } from '../src/engine/rules.js'

const [,, subcmd, ...rest] = process.argv

if (!subcmd) {
  // list all rules
  const rules = listRules(null)
  if (rules.length === 0) { console.log('No rules defined.'); process.exit(0) }
  console.log('\nRules:')
  console.log('  ' + ['ID', 'Tool', 'Pattern', 'Action', 'Priority', 'Label'].join('\t'))
  rules.forEach(r => {
    console.log(`  ${r.id.slice(0,8)}\t${r.tool}\t${r.pattern}\t${r.action}\t${r.priority}\t${r.label || ''}`)
  })
  console.log()

} else if (subcmd === 'project') {
  const rules = listRules(process.cwd())
  if (rules.length === 0) { console.log('No rules scoped to this project.'); process.exit(0) }
  rules.forEach(r => console.log(`  ${r.id.slice(0,8)} | ${r.tool} | ${r.pattern} | ${r.action}`))

} else if (subcmd === 'add') {
  // parse key=value args — iterate rest directly to preserve values with spaces
  // e.g. pattern="npm run *" arrives as one argv item after shell unquoting: "pattern=npm run *"
  const kv = {}
  rest.forEach(arg => {
    const eqIdx = arg.indexOf('=')
    if (eqIdx === -1) return
    kv[arg.slice(0, eqIdx)] = arg.slice(eqIdx + 1)
  })
  if (!kv.tool || !kv.pattern || !kv.action) {
    console.error('Usage: afk:rules add tool=<t> pattern=<p> action=allow|deny [label=<l>] [priority=<n>]')
    process.exit(1)
  }
  const id = addRule({
    tool:     kv.tool,
    pattern:  kv.pattern,
    action:   kv.action,
    label:    kv.label     || undefined,
    priority: kv.priority  ? Number(kv.priority) : 0
  })
  console.log(`Created rule ${id}`)

} else if (subcmd === 'remove') {
  const id = rest[0]
  if (!id) { console.error('Usage: afk:rules remove <id>'); process.exit(1) }
  removeRule(id)
  console.log(`Deleted rule ${id}`)

} else {
  console.error(`Unknown subcommand: ${subcmd}`)
  process.exit(1)
}
```

- [ ] **Step 2: Create `commands/afk-rules.md`**

```markdown
---
name: afk:rules
description: List, add, or remove static approval rules.
---

```bash
SCRIPT="${PLUGIN_DIR}/scripts/afk-rules-cli.js"
if [ -z "$PLUGIN_DIR" ] || [ ! -f "$SCRIPT" ]; then
  SCRIPT="$(git rev-parse --show-toplevel 2>/dev/null)/scripts/afk-rules-cli.js"
fi
node "$SCRIPT" <args>
```

Where `<args>` is what the user typed after `/afk:rules` (empty = list, `add tool=Bash pattern="npm *" action=allow`, `remove <id>`, `project`).

Read the output and present it clearly.
```

- [ ] **Step 3: Manually test**

```bash
node scripts/afk-rules-cli.js
node scripts/afk-rules-cli.js add tool=Bash pattern="npm run *" action=allow label="npm scripts"
node scripts/afk-rules-cli.js
```

Expected: first command shows "No rules defined.", second creates a rule, third shows the rule table.

- [ ] **Step 4: Commit**

```bash
git add scripts/afk-rules-cli.js commands/afk-rules.md
git commit -m "feat: /afk:rules command — terminal rule CRUD"
```

---

### Task 10: `afk-reset-cli.js` + `commands/afk-reset.md`

**Files:**
- Create: `scripts/afk-reset-cli.js`
- Create: `commands/afk-reset.md`

- [ ] **Step 1: Create `scripts/afk-reset-cli.js`**

```js
#!/usr/bin/env node
// scripts/afk-reset-cli.js
import { createInterface } from 'node:readline'
import { getDb } from '../src/store/db.js'

const rl = createInterface({ input: process.stdin, output: process.stdout })
rl.question("Type 'reset' to confirm (this cannot be undone): ", answer => {
  rl.close()
  if (answer.trim() !== 'reset') {
    console.log('Cancelled.')
    process.exit(0)
  }
  const db = getDb()
  const d = db.prepare('DELETE FROM decisions').run().changes
  const s = db.prepare('DELETE FROM sessions').run().changes
  const q = db.prepare('DELETE FROM deferred').run().changes
  const b = db.prepare('DELETE FROM baselines').run().changes
  console.log(`\nReset complete:`)
  console.log(`  decisions:  ${d} rows deleted`)
  console.log(`  sessions:   ${s} rows deleted`)
  console.log(`  deferred:   ${q} rows deleted`)
  console.log(`  baselines:  ${b} rows deleted`)
  console.log(`\nRules and config preserved.`)
})
```

- [ ] **Step 2: Create `commands/afk-reset.md`**

```markdown
---
name: afk:reset
description: Clear all AFK decision history and start fresh. Preserves rules and config.
---

```bash
SCRIPT="${PLUGIN_DIR}/scripts/afk-reset-cli.js"
if [ -z "$PLUGIN_DIR" ] || [ ! -f "$SCRIPT" ]; then
  SCRIPT="$(git rev-parse --show-toplevel 2>/dev/null)/scripts/afk-reset-cli.js"
fi
node "$SCRIPT"
```

This command requires confirmation. Read the output and report back to the user.
Warn the user clearly before proceeding — this deletes all decisions, sessions, deferred items, and baselines.
```

- [ ] **Step 3: Run full test suite — all tests pass**

```bash
node --test test/*.test.js
```

Expected: all tests PASS. `npm test` should also work.

- [ ] **Step 4: Commit**

```bash
git add scripts/afk-reset-cli.js commands/afk-reset.md
git commit -m "feat: /afk:reset command — wipe history with confirmation"
```

---

### Task 11: Wire `express` into `package.json` + final verification

**Files:**
- Verify: `package.json` has `express` in dependencies (from Task 1 step 1)
- Verify: `.claude-plugin/plugin.json` lists all 5 commands (review, stats, rules, reset + existing afk)

- [ ] **Step 1: Verify `package.json` has express (install if missing)**

```bash
node -e "import('express').then(() => console.log('express ok')).catch(e => console.error(e.message))"
```

Expected: `express ok`. If it prints an error instead, run `npm install express` and re-run the check.

- [ ] **Step 2: Check `.claude-plugin/plugin.json` — add new commands if missing**

Read `.claude-plugin/plugin.json`. The `commands` array should include entries for all 5 commands. If `afk-review`, `afk-stats`, `afk-rules`, `afk-reset` are missing, add them:

```json
{ "name": "afk:review", "description": "Open AFK web dashboard in browser" },
{ "name": "afk:stats",  "description": "Show today's decision summary in terminal" },
{ "name": "afk:rules",  "description": "List, add, or remove static rules" },
{ "name": "afk:reset",  "description": "Clear decision history and start fresh" }
```

- [ ] **Step 3: Run full test suite one final time**

```bash
node --test test/*.test.js
```

Expected: all tests PASS. Count should be 127+ (original) plus new store and dashboard tests.

- [ ] **Step 4: Final commit**

```bash
git add .claude-plugin/plugin.json package.json package-lock.json
git commit -m "feat: Phase 6 complete — web dashboard, REST API, UI, slash commands"
```
