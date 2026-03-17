# Phase 7 — Polish & Publish Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the unused `sessions` table for request tracking + token estimation, create the marketplace catalog, and write the full README.

**Architecture:** session.js is a thin store module (same pattern as history.js/queue.js) using prepared statements against the existing sessions table. chain.js gets decision+source fields added to every return. hook.js calls session functions post-chain. README and marketplace.json are static files.

**Tech Stack:** Node.js 18+, better-sqlite3, ESM modules, node:test

**Spec:** `docs/superpowers/specs/2026-03-17-phase7-polish-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/store/session.js` | Create | Session CRUD: ensureSession, updateSessionStats, addTokenEstimate, estimateTokens, getSession, listSessions, getMostRecentSession |
| `test/session.test.js` | Create | 22 test cases for session.js |
| `src/engine/chain.js` | Modify | Add `decision` + `source` fields to all 14 return statements |
| `src/hook.js` | Modify | Add 4 lines post-chain for session tracking |
| `src/dashboard/api.js` | Modify | Add GET /api/sessions and GET /api/sessions/:id |
| `marketplace/marketplace.json` | Create | Marketplace catalog |
| `README.md` | Create | Full project README |

---

## Chunk 1: session.js + tests

### Task 1: Create session.js with ensureSession and estimateTokens

**Files:**
- Create: `src/store/session.js`
- Test: `test/session.test.js`

- [ ] **Step 1: Write the failing tests for ensureSession and estimateTokens**

Create `test/session.test.js`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/session.test.js`
Expected: FAIL — cannot import `ensureSession` or `estimateTokens` from session.js (file does not exist)

- [ ] **Step 3: Write ensureSession and estimateTokens**

Create `src/store/session.js`:

```js
import { getDb } from './db.js'

/**
 * Creates a session row if it does not already exist.
 * @param {string} sessionId
 * @param {string} projectCwd
 * @returns {{ created: boolean }}
 */
export function ensureSession(sessionId, projectCwd) {
  const db = getDb()
  const result = db.prepare(`
    INSERT OR IGNORE INTO sessions (id, started_ts, project_cwd)
    VALUES (?, ?, ?)
  `).run(sessionId, Date.now(), projectCwd)
  return { created: result.changes === 1 }
}

/**
 * Estimates token count for a request based on tool and input size.
 * @param {string} tool
 * @param {object} input
 * @returns {number} estimated tokens (integer, never NaN)
 */
export function estimateTokens(tool, input) {
  switch (tool) {
    case 'Bash':
      return Math.ceil((input.command?.length ?? 0) / 4) + 50
    case 'Write':
      return Math.ceil((input.content?.length ?? 0) / 4) + 50
    case 'Edit':
      return Math.ceil(((input.old_string?.length ?? 0) + (input.new_string?.length ?? 0)) / 4) + 50
    case 'Read':
    case 'Glob':
    case 'Grep':
    case 'LS':
    case 'Search':
      return 100
    default:
      return 100
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/session.test.js`
Expected: All 8 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/store/session.js test/session.test.js
git commit -m "feat: add ensureSession and estimateTokens to session store"
```

---

### Task 2: Add updateSessionStats and addTokenEstimate

**Files:**
- Modify: `src/store/session.js`
- Modify: `test/session.test.js`

- [ ] **Step 1: Write failing tests for updateSessionStats and addTokenEstimate**

Append to `test/session.test.js`:

```js
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
  // In chain.js, notification allow outcomes are logged as source='auto_afk', not 'notification'.
  // This combo never occurs in practice, but if passed directly, it should only increment total_req.
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
```

- [ ] **Step 2: Run tests to verify new tests fail**

Run: `node --test test/session.test.js`
Expected: New tests FAIL — `updateSessionStats` and `addTokenEstimate` not exported

- [ ] **Step 3: Implement updateSessionStats and addTokenEstimate**

Add to `src/store/session.js`:

```js
/**
 * Resolves the counter column to increment based on source+decision.
 * @param {string} decision
 * @param {string} source
 * @returns {string|null} column name or null for total_req only
 */
function resolveCounter(decision, source) {
  if (source === 'auto_afk') return 'auto_allow'
  if (source === 'auto_defer' && decision === 'defer') return 'deferred'
  if (source === 'notification' && decision === 'deny') return 'auto_deny'
  if (source === 'user' && decision === 'allow') return 'user_allow'
  if (source === 'user' && decision === 'deny') return 'user_deny'
  if ((source === 'rule' || source === 'prediction' || source === 'chain') && decision === 'allow') return 'auto_allow'
  if ((source === 'rule' || source === 'prediction' || source === 'chain') && decision === 'deny') return 'auto_deny'
  return null
}

/**
 * Increments session stats for a single decision.
 * @param {string} sessionId
 * @param {string} decision — allow | deny | defer | ask
 * @param {string} source — rule | prediction | chain | auto_afk | auto_defer | notification | user
 */
export function updateSessionStats(sessionId, decision, source) {
  const db = getDb()
  const counter = resolveCounter(decision, source)
  if (counter) {
    // Allowed columns are hardcoded — counter comes from resolveCounter, not user input
    db.prepare(`UPDATE sessions SET total_req = total_req + 1, ${counter} = ${counter} + 1 WHERE id = ?`).run(sessionId)
  } else {
    db.prepare('UPDATE sessions SET total_req = total_req + 1 WHERE id = ?').run(sessionId)
  }
}

/**
 * Adds a token estimate to the session's running total.
 * @param {string} sessionId
 * @param {number} tokens
 */
export function addTokenEstimate(sessionId, tokens) {
  const db = getDb()
  db.prepare('UPDATE sessions SET tokens_est = tokens_est + ? WHERE id = ?').run(tokens, sessionId)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/session.test.js`
Expected: All 18 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/store/session.js test/session.test.js
git commit -m "feat: add updateSessionStats and addTokenEstimate to session store"
```

---

### Task 3: Add query functions (getSession, listSessions, getMostRecentSession)

**Files:**
- Modify: `src/store/session.js`
- Modify: `test/session.test.js`

- [ ] **Step 1: Write failing tests for query functions**

Append to `test/session.test.js`:

```js
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
  // Sessions created in earlier tests have different started_ts values
  // Create two with known ordering
  ensureSession('sess-list-old', '/p')
  // Small delay to ensure different started_ts
  const db = getDb()
  db.prepare('UPDATE sessions SET started_ts = started_ts - 100000 WHERE id = ?').run('sess-list-old')
  ensureSession('sess-list-new', '/p')

  const { sessions, total, page, limit } = listSessions({ page: 1, limit: 2 })
  assert.strictEqual(page, 1)
  assert.strictEqual(limit, 2)
  assert.strictEqual(sessions.length, 2)
  assert.ok(total >= 2)
  // Most recent first
  assert.ok(sessions[0].started_ts >= sessions[1].started_ts)
})

test('getMostRecentSession returns the latest session', () => {
  const row = getMostRecentSession()
  assert.ok(row)
  assert.ok(row.started_ts > 0)
})
```

- [ ] **Step 2: Run tests to verify new tests fail**

Run: `node --test test/session.test.js`
Expected: New tests FAIL — `getSession`, `listSessions`, `getMostRecentSession` not exported

- [ ] **Step 3: Implement query functions**

Add to `src/store/session.js`:

```js
/**
 * Returns a single session by ID.
 * @param {string} sessionId
 * @returns {object|null}
 */
export function getSession(sessionId) {
  const db = getDb()
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) ?? null
}

/**
 * Returns a paginated list of sessions, most recent first.
 * @param {object} opts
 * @param {number} [opts.page=1]
 * @param {number} [opts.limit=20]
 * @returns {{ sessions: object[], total: number, page: number, limit: number }}
 */
export function listSessions({ page = 1, limit = 20 } = {}) {
  const db = getDb()
  const cap = Math.min(Math.max(1, limit), 1000)
  const offset = (Math.max(1, page) - 1) * cap
  const total = db.prepare('SELECT COUNT(*) as c FROM sessions').get().c
  const sessions = db.prepare(
    'SELECT * FROM sessions ORDER BY started_ts DESC LIMIT ? OFFSET ?'
  ).all(cap, offset)
  return { sessions, total, page: Math.max(1, page), limit: cap }
}

/**
 * Returns the most recently started session.
 * @returns {object|null}
 */
export function getMostRecentSession() {
  const db = getDb()
  return db.prepare('SELECT * FROM sessions ORDER BY started_ts DESC LIMIT 1').get() ?? null
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/session.test.js`
Expected: All 22 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/store/session.js test/session.test.js
git commit -m "feat: add getSession, listSessions, getMostRecentSession"
```

---

## Chunk 2: chain.js + hook.js + api.js integration

### Task 4: Add decision+source to chain.js return values

**Files:**
- Modify: `src/engine/chain.js`

- [ ] **Step 1: Run existing chain tests to establish baseline**

Run: `node --test test/chain.test.js`
Expected: All existing tests PASS

- [ ] **Step 2: Modify every return statement in chain.js**

Update `src/engine/chain.js` — add `decision` and `source` fields to every return. The 14 return paths per the spec mapping:

Line 41 (deadline expired):
```js
return { behavior: 'ask', decision: 'ask', source: 'chain', reason: 'deadline expired before chain start' }
```

Line 62 (sensitive path):
```js
return { behavior: 'ask', decision: 'ask', source: 'chain', reason: `Sensitive path detected: ${sensitive.matched}` }
```

Line 70 (injection):
```js
return { behavior: 'deny', decision: 'deny', source: 'chain', reason: injection.reason }
```

Line 86 (destructive + deny rule):
```js
return { behavior: 'deny', decision: 'deny', source: 'rule', reason: `Matched deny rule: ${denyRule.label ?? denyRule.pattern}` }
```

Line 115 (destructive + AFK on):
```js
return { behavior: 'ask', decision: 'defer', source: 'auto_defer', reason: `Destructive action deferred: ${destructive.reason}` }
```

Line 120 (destructive + AFK off):
```js
return { behavior: 'ask', decision: 'ask', source: 'chain', reason: `Destructive action detected: ${destructive.reason}` }
```

Line 128 (static rule match):
```js
return { behavior, decision: behavior, source: 'rule', reason: `Matched rule: ${rule.label ?? rule.pattern}` }
```

Line 151 (anomaly + AFK on):
```js
return { behavior: 'ask', decision: 'defer', source: 'auto_defer', reason: `Anomalous request deferred: ${anomaly.reason}` }
```

Line 155 (anomaly + AFK off):
```js
return { behavior: 'ask', decision: 'ask', source: 'chain', reason: `Unusual request detected: ${anomaly.reason}` }
```

Line 164 (high confidence prediction):
```js
return { behavior, decision: behavior, source: 'prediction', reason: prediction.explanation }
```

Line 168 (low confidence auto-deny):
```js
return { behavior: 'deny', decision: 'deny', source: 'prediction', reason: prediction.explanation }
```

Line 181 (notification deny):
```js
return { behavior: 'deny', decision: 'deny', source: 'notification', reason: 'Denied via push notification' }
```

Line 186 (AFK auto-approve):
```js
return { behavior: 'allow', decision: 'allow', source: 'auto_afk', reason: 'AFK mode: auto-approved' }
```

Line 191 (mid-band AFK off):
```js
return { behavior: 'ask', decision: 'ask', source: 'prediction', reason: 'Insufficient confidence — user input required' }
```

Also update the JSDoc return type on line 36:
```js
 * @returns {Promise<{ behavior: 'allow'|'deny'|'ask', decision: string, source: string, reason: string }>}
```

- [ ] **Step 3: Run chain tests to verify nothing broke**

Run: `node --test test/chain.test.js`
Expected: All existing tests PASS (they only assert `r.behavior`, new fields are additive)

- [ ] **Step 4: Commit**

```bash
git add src/engine/chain.js
git commit -m "feat: add decision and source fields to all chain return paths"
```

---

### Task 5: Wire session tracking into hook.js

**Files:**
- Modify: `src/hook.js`

- [ ] **Step 1: Add session imports and post-chain calls to hook.js**

In `src/hook.js`, add the import at the top (after existing imports):
```js
import { ensureSession, updateSessionStats, addTokenEstimate, estimateTokens } from './store/session.js'
```

After the `updateBaseline` call (line 34) and before `process.stdout.write` (line 35), add:
```js
    try {
      ensureSession(request.session_id, request.cwd)
      updateSessionStats(request.session_id, result.decision ?? result.behavior ?? 'ask', result.source ?? 'chain')
      addTokenEstimate(request.session_id, estimateTokens(request.tool, request.input))
    } catch { /* non-fatal — session tracking must never block hook */ }
```

- [ ] **Step 2: Run all tests to verify nothing broke**

Run: `node --test test/*.test.js`
Expected: All tests PASS (156+ existing tests)

- [ ] **Step 3: Commit**

```bash
git add src/hook.js
git commit -m "feat: wire session tracking into hook entry point"
```

---

### Task 6: Add session API endpoints to dashboard

**Files:**
- Modify: `src/dashboard/api.js`

- [ ] **Step 1: Add session endpoints to api.js**

In `src/dashboard/api.js`, add the import to the existing import block at the top of the file (after line 7, alongside the other store imports):
```js
import { getSession, listSessions } from '../store/session.js'
```

Add the two routes before the `export default router` line (line 134):

```js
// ── GET /api/sessions ──────────────────────────────────────────────────────────
router.get('/sessions', (req, res) => {
  const { page, limit } = req.query
  const result = listSessions({
    page:  page  ? Number(page)  : 1,
    limit: limit ? Number(limit) : 20
  })
  res.json(result)
})

// ── GET /api/sessions/:id ────────────────────────────────────────────────────────
router.get('/sessions/:id', (req, res) => {
  const row = getSession(req.params.id)
  if (!row) return res.status(404).json({ error: 'session not found' })
  res.json(row)
})
```

- [ ] **Step 2: Run API tests to verify nothing broke**

Run: `node --test test/api.test.js`
Expected: All existing API tests PASS

- [ ] **Step 3: Commit**

```bash
git add src/dashboard/api.js
git commit -m "feat: add GET /api/sessions and GET /api/sessions/:id endpoints"
```

---

## Chunk 3: marketplace.json + README.md

### Task 7: Create marketplace.json

**Files:**
- Create: `marketplace/marketplace.json`

- [ ] **Step 1: Create marketplace directory and JSON file**

Create `marketplace/marketplace.json`:

```json
{
  "name": "drprockz/afk-marketplace",
  "description": "drprockz plugin marketplace — AFK and future tools",
  "plugins": [
    {
      "name": "afk",
      "description": "Intelligent permission layer for Claude Code. AFK mode, behavior prediction, destructive action deferral.",
      "version": "0.1.0",
      "source": "https://github.com/drprockz/afk",
      "categories": ["safety", "productivity", "automation"]
    }
  ]
}
```

- [ ] **Step 2: Commit**

```bash
git add marketplace/marketplace.json
git commit -m "feat: add marketplace catalog for drprockz/afk-marketplace"
```

---

### Task 8: Create README.md

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write README.md**

Create `README.md` with the following structure (see spec §3 for structure). Key content:

1. **Opening** — Philosophy statement verbatim from CLAUDE.md lines 5-11:
   > Claude Code interrupts you. Every permission prompt is a context switch that breaks flow. When you step away, Claude stalls entirely. When it does proceed, you have no record of what it decided or why.
   >
   > AFK is the intelligent permission layer that fixes this. It learns how you work, decides confidently on your behalf, defers what's dangerous, and never lets Claude stall because you're not watching.
   >
   > **Core principle: Claude should never interrupt you when you're away, and should never do something irreversible without your knowledge.**
   >
   > Every feature in this project flows from that sentence.

2. **One-liner** — "A Claude Code plugin that learns your permission patterns, handles requests while you're away, and defers dangerous actions for your review."

3. **Install** — Two commands:
   ```
   /plugin marketplace add drprockz/afk-marketplace
   /plugin install afk@drprockz
   ```

4. **Features** — Bullet list of capabilities

5. **How it works** — Text-art decision chain diagram from spec §3 (7 steps matching chain.js order + notification)

6. **AFK mode** — On/off behavior, digest, deferral queue

7. **Configuration** — Key config.json fields with explanations:
   - `thresholds.autoApprove` (0.85)
   - `thresholds.autoDeny` (0.15)
   - `safety.snapshotBeforeDestructive` (true)
   - `notifications.provider` (null/ntfy/telegram)
   - `dashboard.port` (6789)

8. **Commands** — Table of 5 slash commands with descriptions

9. **Contributing** — Fork, `npm install`, `node --test test/*.test.js`, PR

10. **License** — MIT

Target: ~200–300 lines. No emojis. No screenshots.

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add full README with philosophy, features, and decision chain diagram"
```

---

### Task 9: Run full test suite and verify

**Files:** None (verification only)

- [ ] **Step 1: Run complete test suite**

Run: `node --test test/*.test.js`
Expected: All tests PASS (156 existing + 22 new session tests = 178+)

- [ ] **Step 2: Verify hook.js works end-to-end**

Run a quick smoke test by piping a sample PermissionRequest:
```bash
echo '{"tool":"Bash","input":{"command":"ls"},"session_id":"test-e2e","cwd":"/tmp"}' | node src/hook.js
```
Expected: JSON output with `behavior` field. Check stderr for no errors.

- [ ] **Step 3: Verify session was created**

```bash
node --input-type=module -e "
  import { homedir } from 'node:os';
  process.env.AFK_DB_DIR = homedir() + '/.claude/afk';
  const { getSession } = await import('./src/store/session.js');
  console.log(getSession('test-e2e'));
"
```
Expected: Session row with `total_req >= 1`

Note: If `~/.claude/afk/` doesn't exist on the dev machine, skip this step — it only works when AFK is installed.
