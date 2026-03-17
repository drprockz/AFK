# Phase 3 — AFK + Safety Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add AFK safety net (git snapshot before destructive deferral), a deferral queue, idle auto-AFK detector, session digest, and the `/afk` slash command CLI.

**Architecture:** Six new files + two modified files, wired bottom-up (foundations first, then chain integration, then user-facing CLI). All DB operations are synchronous (better-sqlite3). The idle detector is stateless — no daemon, no timers; it runs on every hook invocation and measures the gap since the last request.

**Tech Stack:** Node.js 18+ ESM, `better-sqlite3` (sync SQLite), `node:child_process` `execFile` for git commands, `node:test` + `node:assert` for tests.

---

## File Map

| File | Status | Responsibility |
|------|--------|----------------|
| `src/afk/state.js` | **modify** | Add `last_request_ts: null` to defaultState; export `getState()` and `touchLastRequestTs()` |
| `src/store/queue.js` | **create** | Deferred queue CRUD over the `deferred` SQLite table |
| `src/safety/snapshot.js` | **create** | Git checkpoint (add -A + commit) before destructive defer |
| `src/afk/detector.js` | **create** | Request-gap idle detector; auto-enables AFK after N quiet minutes |
| `src/afk/digest.js` | **create** | Pure formatter — turns digest entries into a human-readable string |
| `src/engine/chain.js` | **modify** | Wire `checkAndAutoAfk()` at entry; replace Phase 3 comment with snapshot+queue+appendDigest |
| `scripts/afk-cli.js` | **create** | Executable CLI invoked by `/afk` slash command |
| `commands/afk.md` | **create** | `/afk` slash command prompt for Claude Code |
| `test/state.test.js` | **modify** | Add 2 tests for `getState()` and `touchLastRequestTs()` |
| `test/queue.test.js` | **create** | 4 tests for queue CRUD |
| `test/snapshot.test.js` | **create** | 4 tests using real temp git repos |
| `test/detector.test.js` | **create** | 5 tests for auto-AFK behavior |
| `test/digest.test.js` | **create** | 4 tests for pure digest output |
| `test/chain.test.js` | **modify** | Update 1 existing test comment; add 2 new AFK-ON destructive tests |
| `test/afk-cli.test.js` | **create** | 4 tests spawning the CLI as a child process |

---

## Chunk 1: State + Queue

### Task 1: `src/afk/state.js` — add `getState()`, `touchLastRequestTs()`, `last_request_ts`

**Files:**
- Modify: `src/afk/state.js`
- Modify: `test/state.test.js`

- [ ] **Step 1.1: Write the 2 failing tests** — add to the bottom of `test/state.test.js`:

```js
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
```

Also update the import line at the top of `test/state.test.js` to include `getState` and `touchLastRequestTs`:
```js
const { isAfk, setAfk, getSessionId, appendDigest, getAndClearDigest, getState, touchLastRequestTs } =
  await import('../src/afk/state.js')
```

- [ ] **Step 1.2: Run to verify they fail**

```bash
node --test test/state.test.js
```

Expected: `SyntaxError` or `TypeError: getState is not a function` (not exported yet).

- [ ] **Step 1.3: Implement in `src/afk/state.js`**

Add `last_request_ts: null` to `defaultState()`:
```js
function defaultState() {
  return {
    afk: false,
    afk_since: null,
    afk_until: null,
    session_id: randomUUID(),
    auto_afk_minutes: 15,
    digest: [],
    last_request_ts: null   // ← NEW
  }
}
```

Add two exports at the bottom of `src/afk/state.js`:
```js
/**
 * Returns the full current state object. Read-only snapshot.
 * @returns {object}
 */
export function getState() {
  return readState()
}

/**
 * Updates last_request_ts to the current time.
 * MUST be read-modify-write — spreads current state, not defaultState.
 * Called by detector.js on every hook invocation.
 * @returns {void}
 */
export function touchLastRequestTs() {
  const state = readState()
  writeState({ ...state, last_request_ts: Date.now() })
}
```

- [ ] **Step 1.4: Run to verify they pass**

```bash
node --test test/state.test.js
```

Expected: all 8 tests pass.

- [ ] **Step 1.5: Run full suite to check no regressions**

```bash
node --test test/*.test.js
```

Expected: all existing tests pass (the new fields in `defaultState` are backward-compatible).

- [ ] **Step 1.6: Commit**

```bash
git add src/afk/state.js test/state.test.js
git commit -m "feat: add getState, touchLastRequestTs, last_request_ts to state.js"
```

---

### Task 2: `src/store/queue.js` — deferred queue CRUD

**Files:**
- Create: `src/store/queue.js`
- Create: `test/queue.test.js`

- [ ] **Step 2.1: Write the failing tests** — create `test/queue.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AFK_DB_DIR = join(tmpdir(), 'afk-queue-test-' + Date.now())

const { enqueueDeferred, getPendingItems, resolveItem, getPendingCount } =
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
```

- [ ] **Step 2.2: Run to verify they fail**

```bash
node --test test/queue.test.js
```

Expected: `Error: Cannot find module '../src/store/queue.js'`

- [ ] **Step 2.3: Create `src/store/queue.js`**

```js
// src/store/queue.js
import { getDb } from './db.js'

/**
 * Inserts a new deferred item into the queue.
 * Truncates input.content to 5000 chars if present (prevents SQLite bloat from Write/Edit tools).
 * @param {object} opts
 * @param {number} opts.decisionsId — FK to decisions.id of the originating defer row
 * @param {string} opts.sessionId
 * @param {string} opts.tool
 * @param {object} opts.input — original request input (unsanitized, for human review)
 * @param {string|null} opts.command
 * @param {string|null} opts.path
 * @returns {number} new deferred row id
 */
export function enqueueDeferred({ decisionsId, sessionId, tool, input, command, path }) {
  const db = getDb()
  // Size-cap: Write/Edit inputs can carry megabytes of file content
  const safeInput = (typeof input.content === 'string' && input.content.length > 5000)
    ? { ...input, content: input.content.slice(0, 5000) + '...[truncated]' }
    : input
  const result = db.prepare(`
    INSERT INTO deferred (ts, session_id, tool, input, command, path, decisions_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(Date.now(), sessionId, tool, JSON.stringify(safeInput), command ?? null, path ?? null, decisionsId)
  return result.lastInsertRowid
}

/**
 * Returns all unreviewed deferred items, oldest first.
 * @returns {Array<object>} deferred rows with reviewed=0
 */
export function getPendingItems() {
  const db = getDb()
  return db.prepare(`
    SELECT * FROM deferred WHERE reviewed = 0 ORDER BY ts ASC
  `).all()
}

/**
 * Marks a deferred item as reviewed with a final decision.
 * @param {number} id — deferred row id
 * @param {'allow'|'deny'} final
 * @returns {boolean} true if row was updated, false if id did not exist
 */
export function resolveItem(id, final) {
  const db = getDb()
  const result = db.prepare(`
    UPDATE deferred SET reviewed = 1, final = ?, review_ts = ? WHERE id = ?
  `).run(final, Date.now(), id)
  return result.changes > 0
}

/**
 * Returns the count of unreviewed deferred items.
 * @returns {number}
 */
export function getPendingCount() {
  const db = getDb()
  return db.prepare(`SELECT COUNT(*) as c FROM deferred WHERE reviewed = 0`).get().c
}
```

- [ ] **Step 2.4: Run to verify they pass**

```bash
node --test test/queue.test.js
```

Expected: all 4 tests pass.

- [ ] **Step 2.5: Run full suite**

```bash
node --test test/*.test.js
```

Expected: all tests pass.

- [ ] **Step 2.6: Commit**

```bash
git add src/store/queue.js test/queue.test.js
git commit -m "feat: add deferral queue CRUD (src/store/queue.js)"
```

---

## Chunk 2: Snapshot + Detector

### Task 3: `src/safety/snapshot.js` — git checkpoint before destructive defer

**Files:**
- Create: `src/safety/snapshot.js`
- Create: `test/snapshot.test.js`

- [ ] **Step 3.1: Create `test/snapshot.test.js`** (uses real temp git repos — no mocking needed)

```js
import { test } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// snapshot.js uses node:child_process directly — no DB, no AFK state
const { snapshot } = await import('../src/safety/snapshot.js')

function makeTempGitRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'afk-snap-'))
  execFileSync('git', ['init'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  // Create an empty initial commit so snapshot commits are never root-commits.
  // Root-commit output includes "(root-commit)" which breaks hash parsing:
  //   [main (root-commit) abc1234] → regex fails to extract hash
  execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: dir })
  return dir
}

test('returns snapshotted=true with commit hash when repo has changes', async () => {
  const dir = makeTempGitRepo()
  writeFileSync(join(dir, 'work.txt'), 'some work')
  const result = await snapshot(dir, 'rm -rf dist/')
  assert.strictEqual(result.snapshotted, true)
  assert.ok(typeof result.commit === 'string' && result.commit.length > 0, 'commit hash must be a non-empty string')
})

test('returns snapshotted=false when working tree is clean', async () => {
  const dir = makeTempGitRepo()
  // makeTempGitRepo() already creates an empty initial commit — tree is already clean
  const result = await snapshot(dir, 'test reason')
  assert.strictEqual(result.snapshotted, false)
  assert.strictEqual(result.commit, null)
})

test('returns snapshotted=false when cwd is not a git repo', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'afk-nogit-'))
  const result = await snapshot(dir, 'test reason')
  assert.strictEqual(result.snapshotted, false)
  assert.strictEqual(result.commit, null)
})

test('never throws — returns gracefully on git failure', async () => {
  // Pass a non-existent path — git will fail
  const result = await snapshot('/non/existent/path/xyz', 'test')
  assert.strictEqual(result.snapshotted, false)
  assert.strictEqual(result.commit, null)
})
```

- [ ] **Step 3.2: Run to verify they fail**

```bash
node --test test/snapshot.test.js
```

Expected: `Error: Cannot find module '../src/safety/snapshot.js'`

- [ ] **Step 3.3: Create `src/safety/snapshot.js`**

```js
// src/safety/snapshot.js
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * Creates a git checkpoint before a destructive deferred action.
 * Runs `git add -A` + `git commit`. Non-blocking on failure.
 * Uses execFile (not exec) to avoid shell injection on cwd or reason.
 * @param {string} cwd — project working directory
 * @param {string} reason — human-readable reason (embedded in commit message)
 * @returns {Promise<{ snapshotted: boolean, commit: string | null }>}
 */
export async function snapshot(cwd, reason) {
  // Step 1: verify cwd is a git repo
  try {
    await execFileAsync('git', ['rev-parse', '--git-dir'], { cwd })
  } catch {
    return { snapshotted: false, commit: null }
  }

  // Step 2: stage all changes
  try {
    await execFileAsync('git', ['add', '-A'], { cwd })
  } catch (err) {
    process.stderr.write(`afk snapshot: git add failed: ${err.message}\n`)
    return { snapshotted: false, commit: null }
  }

  // Step 3: commit — leave staged state if this fails (per spec: no cleanup)
  try {
    const { stdout } = await execFileAsync('git', [
      'commit', '-m', `afk: checkpoint before ${reason} [skip ci]`
    ], { cwd })
    // Git stdout format: "[branch-name abc1234] message"
    const match = stdout.match(/\[[\w/.\-]+ ([0-9a-f]+)\]/)
    const commit = match?.[1] ?? null
    return { snapshotted: true, commit }
  } catch (err) {
    const output = String(err.stdout ?? '') + String(err.stderr ?? '')
    if (output.includes('nothing to commit')) {
      return { snapshotted: false, commit: null }
    }
    process.stderr.write(`afk snapshot: git commit failed: ${err.message}\n`)
    return { snapshotted: false, commit: null }
  }
}
```

- [ ] **Step 3.4: Run to verify they pass**

```bash
node --test test/snapshot.test.js
```

Expected: all 4 tests pass. (Test 1 may take ~1s for git operations — that's normal.)

- [ ] **Step 3.5: Run full suite**

```bash
node --test test/*.test.js
```

Expected: all tests pass.

- [ ] **Step 3.6: Commit**

```bash
git add src/safety/snapshot.js test/snapshot.test.js
git commit -m "feat: safety snapshot — git checkpoint before destructive defer"
```

---

### Task 4: `src/afk/detector.js` — request-gap idle auto-AFK

**Files:**
- Create: `src/afk/detector.js`
- Create: `test/detector.test.js`

- [ ] **Step 4.1: Create `test/detector.test.js`**

```js
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
```

- [ ] **Step 4.2: Run to verify they fail**

```bash
node --test test/detector.test.js
```

Expected: `Error: Cannot find module '../src/afk/detector.js'`

- [ ] **Step 4.3: Create `src/afk/detector.js`**

```js
// src/afk/detector.js
import { getState, setAfk, touchLastRequestTs } from './state.js'

/**
 * Checks if the user has been idle long enough to auto-enable AFK.
 * Updates last_request_ts unconditionally on every call.
 * Reads auto_afk_minutes from state file (not config.json).
 * @returns {void}
 */
export function checkAndAutoAfk() {
  const state = getState()
  const { auto_afk_minutes, afk, last_request_ts } = state

  // Conditions that skip the idle check (but still update timestamp):
  // - First invocation (last_request_ts === null)
  // - auto-AFK disabled (auto_afk_minutes === 0)
  // - already in AFK mode (afk === true)
  if (last_request_ts === null || auto_afk_minutes === 0 || afk) {
    touchLastRequestTs()
    return
  }

  const elapsed = Date.now() - last_request_ts
  if (elapsed > auto_afk_minutes * 60 * 1000) {
    const elapsedMinutes = Math.floor(elapsed / 60_000)
    setAfk(true)
    process.stderr.write(`afk: auto-AFK enabled after ${elapsedMinutes} minutes idle\n`)
  }

  touchLastRequestTs()
}
```

- [ ] **Step 4.4: Run to verify they pass**

```bash
node --test test/detector.test.js
```

Expected: all 5 tests pass.

- [ ] **Step 4.5: Run full suite**

```bash
node --test test/*.test.js
```

Expected: all tests pass.

- [ ] **Step 4.6: Commit**

```bash
git add src/afk/detector.js test/detector.test.js
git commit -m "feat: idle detector — request-gap auto-AFK (src/afk/detector.js)"
```

---

## Chunk 3: Digest + Chain Wiring

### Task 5: `src/afk/digest.js` — pure session digest formatter

**Files:**
- Create: `src/afk/digest.js`
- Create: `test/digest.test.js`

- [ ] **Step 5.1: Create `test/digest.test.js`**

```js
import { test } from 'node:test'
import assert from 'node:assert'

// digest.js is a pure function — no env vars or DB needed
const { buildDigest } = await import('../src/afk/digest.js')

test('groups allow entries by tool with counts', () => {
  const entries = [
    { tool: 'Bash', command: 'npm run build', path: null, decision: 'allow', ts: 1 },
    { tool: 'Bash', command: 'npm test', path: null, decision: 'allow', ts: 2 },
    { tool: 'Read', command: null, path: 'src/app.js', decision: 'allow', ts: 3 },
  ]
  const result = buildDigest(entries, 0)
  assert.ok(result.includes('Auto-approved (3)'), 'should show total auto-approved count')
  assert.ok(result.includes('Bash ×2'), 'should group Bash entries')
  assert.ok(result.includes('Read ×1'), 'should group Read entries')
})

test('lists defer entries individually with sequential index', () => {
  const entries = [
    { tool: 'Bash', command: 'rm -rf dist/', path: null, decision: 'defer', ts: 1 },
    { tool: 'Bash', command: 'DROP TABLE logs', path: null, decision: 'defer', ts: 2 },
  ]
  const result = buildDigest(entries, 2)
  assert.ok(result.includes('[1] Bash: rm -rf dist/'), 'first deferred item')
  assert.ok(result.includes('[2] Bash: DROP TABLE logs'), 'second deferred item')
})

test('returns "No activity during AFK session." when entries empty and pendingCount=0', () => {
  const result = buildDigest([], 0)
  assert.strictEqual(result, 'No activity during AFK session.')
})

test('silently ignores entries with unknown decision values', () => {
  const entries = [
    { tool: 'Bash', command: 'npm test', path: null, decision: 'allow', ts: 1 },
    { tool: 'Bash', command: 'something', path: null, decision: 'ask', ts: 2 },  // unknown
    { tool: 'Bash', command: 'other', path: null, decision: 'deny', ts: 3 },    // unknown
  ]
  const result = buildDigest(entries, 0)
  assert.ok(result.includes('Auto-approved (1)'), 'only 1 allow entry counted')
  assert.ok(!result.includes('ask'), 'ask entries not shown')
  assert.ok(!result.includes('deny'), 'deny entries not shown')
})

test('shows deferred section when entries empty but pendingCount > 0', () => {
  // Covers spec: "entries is empty but pendingCount > 0 → show only the deferred section"
  const result = buildDigest([], 3)
  assert.ok(result !== 'No activity during AFK session.', 'should not return no-activity message')
  assert.ok(result.includes('Deferred for your review (3)'), 'should show deferred count')
})
```

- [ ] **Step 5.2: Run to verify they fail**

```bash
node --test test/digest.test.js
```

Expected: `Error: Cannot find module '../src/afk/digest.js'`

- [ ] **Step 5.3: Create `src/afk/digest.js`**

```js
// src/afk/digest.js

/**
 * Builds a human-readable AFK session digest string.
 * Pure function — no I/O, no DB access.
 * @param {object[]} entries — digest entries (decision: 'allow' | 'defer'; others silently ignored)
 * @param {number} pendingCount — number of unreviewed deferred items in queue
 * @returns {string} formatted digest text
 */
export function buildDigest(entries, pendingCount) {
  const allowed = entries.filter(e => e.decision === 'allow')
  const deferred = entries.filter(e => e.decision === 'defer')

  // Guard: empty entries AND no pending queue items
  // Note: use entries.length (not allowed.length) so defer-only digests are not swallowed
  if (entries.length === 0 && pendingCount === 0) {
    return 'No activity during AFK session.'
  }

  const lines = []
  const total = allowed.length + Math.max(pendingCount, deferred.length)
  lines.push(`AFK session digest — ${total} actions while away`)
  lines.push('')

  if (allowed.length > 0) {
    // Group by tool; within each group collect unique labels (command or path)
    const byTool = {}
    for (const e of allowed) {
      if (!byTool[e.tool]) byTool[e.tool] = []
      byTool[e.tool].push(e.command ?? e.path ?? e.tool)
    }
    lines.push(`Auto-approved (${allowed.length}):`)
    for (const [tool, items] of Object.entries(byTool)) {
      const unique = [...new Set(items)]
      const shown = unique.slice(0, 3).join(', ')
      const extra = unique.length > 3 ? ` and ${unique.length - 3} more` : ''
      lines.push(`  • ${tool} ×${items.length} — ${shown}${extra}`)
    }
    lines.push('')
  }

  const effectivePending = Math.max(pendingCount, deferred.length)
  if (effectivePending > 0) {
    lines.push(`Deferred for your review (${effectivePending}):`)
    deferred.forEach((e, i) => {
      const label = e.command ?? e.path ?? e.tool
      lines.push(`  • [${i + 1}] ${e.tool}: ${label}`)
    })
    if (deferred.length === 0 && pendingCount > 0) {
      lines.push(`  (${pendingCount} item(s) pending — run /afk off to review)`)
    }
    lines.push('')
  }

  lines.push('Run /afk:review to process deferred items in the dashboard (Phase 6).')
  return lines.join('\n')
}
```

- [ ] **Step 5.4: Run to verify they pass**

```bash
node --test test/digest.test.js
```

Expected: all 5 tests pass.

- [ ] **Step 5.5: Run full suite**

```bash
node --test test/*.test.js
```

Expected: all tests pass.

- [ ] **Step 5.6: Commit**

```bash
git add src/afk/digest.js test/digest.test.js
git commit -m "feat: session digest formatter (src/afk/digest.js)"
```

---

### Task 6: `src/engine/chain.js` — wire Phase 3 into the destructive path

**Files:**
- Modify: `src/engine/chain.js`
- Modify: `test/chain.test.js`

The changes:
1. Import `checkAndAutoAfk` from `detector.js`, `snapshot` from `snapshot.js`, `enqueueDeferred` from `queue.js`
2. Call `checkAndAutoAfk()` before `isAfk()` at chain entry
3. Replace the Phase 3 comment block in step 3 (AFK-ON destructive path) with snapshot + queue + appendDigest
4. In that path, call `logDecision()` directly (not via `log()`) to capture the row id

- [ ] **Step 6.1: Add 2 new tests + update 1 existing test in `test/chain.test.js`**

Add the import for queue at the top (after existing imports):
```js
const { getPendingItems } = await import('../src/store/queue.js')
```

Update the existing test at line 79 — change the comment (behavior is still `ask`):
```js
test('AFK ON + destructive → ask returned (defer path now active)', async () => {
  setAfk(true)
  const beforeCount = getPendingItems().length
  const r = await chain({ tool: 'Bash', input: { command: 'rm -rf build/' }, session_id: 's1', cwd }, deadline())
  assert.strictEqual(r.behavior, 'ask')
  const afterCount = getPendingItems().length
  assert.ok(afterCount > beforeCount, 'deferred queue should have grown by at least 1')
  setAfk(false)
})
```

Add 2 new tests at the bottom of `test/chain.test.js`:
```js
test('AFK ON + destructive → deferred item has correct tool and command', async () => {
  setAfk(true)
  const before = getPendingItems().length
  await chain({ tool: 'Bash', input: { command: 'rm -rf tmp/' }, session_id: 's1', cwd }, deadline())
  const items = getPendingItems()
  assert.ok(items.length > before, 'a new deferred item must be inserted')
  const newItem = items[items.length - 1]
  assert.strictEqual(newItem.tool, 'Bash', 'deferred item must record correct tool')
  assert.strictEqual(newItem.command, 'rm -rf tmp/', 'deferred item must record correct command')
  setAfk(false)
})

test('AFK ON + destructive with near-expired deadline → snapshot skipped, item still deferred', async () => {
  setAfk(true)
  const before = getPendingItems().length
  // deadline is only 2000ms away — remaining will be < 3000ms so snapshot is skipped
  const nearExpired = Date.now() + 2000
  const r = await chain({ tool: 'Bash', input: { command: 'rm -rf coverage/' }, session_id: 's1', cwd }, nearExpired)
  assert.strictEqual(r.behavior, 'ask', 'should still return ask')
  const after = getPendingItems().length
  assert.ok(after > before, 'item must be deferred even when snapshot is skipped')
  setAfk(false)
})
```

- [ ] **Step 6.2: Run chain tests to verify the new tests fail**

```bash
node --test test/chain.test.js
```

Expected: the 2 new tests fail (queue not yet populated since chain isn't wired yet). The updated existing test also fails.

- [ ] **Step 6.3: Modify `src/engine/chain.js`**

**Add imports at the top** (after existing imports):
```js
import { checkAndAutoAfk } from '../afk/detector.js'
import { snapshot } from '../safety/snapshot.js'
import { enqueueDeferred } from '../store/queue.js'
```

**Wire `checkAndAutoAfk()` before `isAfk()`** — in `chain()`, the current line is:
```js
const afkOn = isAfk()
```

Replace it with:
```js
checkAndAutoAfk()           // may flip state to AFK on before we read it
const afkOn = isAfk()       // reads updated state
```

**Replace the AFK-ON destructive block** — the current `if (afkOn) { ... } else { ... }` block ending at line 89 in `chain.js`:

```js
    // BEFORE (lines 81–89) — replace this entire if/else block:
    if (afkOn) {
      // AFK-ON: log as defer + auto_defer source per spec.
      // Phase 3 will also add snapshot() call and deferred queue row insert here.
      log('defer', 'auto_defer', { reason: `Destructive: ${destructive.reason} (${destructive.severity})` })
    } else {
      // AFK-OFF: log as ask + chain source (hard safety gate, not a user/rule/prediction decision)
      log('ask', 'chain', { reason: `Destructive: ${destructive.reason} (${destructive.severity})` })
    }
    return { behavior: 'ask', reason: `Destructive action detected: ${destructive.reason}` }
```

Replace with:
```js
    // AFTER — AFK-ON branch now returns early; AFK-OFF falls through to the return below
    if (afkOn) {
      // AFK-ON: snapshot → log → enqueue → appendDigest → ask
      // logDecision called DIRECTLY (not via log()) to capture lastInsertRowid for FK
      // enqueueDeferred receives original `input`, NOT `inputWithExistence` (no internal annotations)
      const remaining = deadline - Date.now()
      let snapshotResult = { snapshotted: false, commit: null }
      if (remaining > 3000) {
        snapshotResult = await snapshot(cwd, destructive.reason)
      }
      const snapshotNote = snapshotResult.snapshotted
        ? `Snapshot: ${snapshotResult.commit}`
        : 'Snapshot: skipped'
      let decisionsId
      try {
        decisionsId = logDecision({
          session_id, tool, input, command, path,
          decision: 'defer',
          source: 'auto_defer',
          project_cwd: cwd,
          reason: `Destructive: ${destructive.reason} (${destructive.severity}). ${snapshotNote}`
        })
      } catch { /* non-fatal */ }
      if (decisionsId != null) {
        try { enqueueDeferred({ decisionsId, sessionId: session_id, tool, input, command, path }) } catch { /* non-fatal */ }
      }
      appendDigest({ tool, command, path, decision: 'defer', ts: Date.now() })
      return { behavior: 'ask', reason: `Destructive action deferred: ${destructive.reason}` }
    } else {
      // AFK-OFF: log as ask + chain source (hard safety gate, not a user/rule/prediction decision)
      log('ask', 'chain', { reason: `Destructive: ${destructive.reason} (${destructive.severity})` })
    }
    return { behavior: 'ask', reason: `Destructive action detected: ${destructive.reason}` }
```

**Important:** the `else` branch and the final `return` on the last line above must be preserved — the AFK-OFF path still needs them.

- [ ] **Step 6.4: Run chain tests to verify they pass**

```bash
node --test test/chain.test.js
```

Expected: all 12 tests pass (10 original + 2 new).

- [ ] **Step 6.5: Run full suite**

```bash
node --test test/*.test.js
```

Expected: all tests pass.

- [ ] **Step 6.6: Commit**

```bash
git add src/engine/chain.js test/chain.test.js
git commit -m "feat: wire Phase 3 into chain — snapshot + defer queue + auto-AFK detector"
```

---

## Chunk 4: CLI + Slash Command

### Task 7: `scripts/afk-cli.js` — executable CLI for `/afk` slash command

**Files:**
- Create: `scripts/afk-cli.js`
- Create: `test/afk-cli.test.js`

The CLI is tested by spawning it as a child process (it's a runnable script with side effects, not a pure module). Tests use `execFile` with custom `AFK_DB_DIR` and `AFK_STATE_DIR` env vars.

- [ ] **Step 7.1: Create `test/afk-cli.test.js`**

```js
import { test } from 'node:test'
import assert from 'node:assert'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'

const execFileAsync = promisify(execFile)
const __dir = dirname(fileURLToPath(import.meta.url))
const CLI = join(__dir, '..', 'scripts', 'afk-cli.js')

// Each test gets isolated state and DB dirs
function makeEnv() {
  return {
    ...process.env,
    AFK_STATE_DIR: mkdtempSync(join(tmpdir(), 'afk-cli-state-')),
    AFK_DB_DIR: mkdtempSync(join(tmpdir(), 'afk-cli-db-'))
  }
}

async function run(args, env) {
  const { stdout } = await execFileAsync('node', [CLI, ...args], { env })
  return stdout
}

/**
 * Directly inserts a decisions + deferred row into the isolated DB.
 * Returns the deferred row id for use in resolve tests.
 */
function insertTestDeferredItem(dbDir) {
  mkdirSync(dbDir, { recursive: true })
  const db = new Database(join(dbDir, 'afk.db'))
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE IF NOT EXISTS decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL,
      session_id TEXT NOT NULL, tool TEXT NOT NULL, input TEXT NOT NULL,
      command TEXT, path TEXT, decision TEXT NOT NULL, source TEXT NOT NULL,
      confidence REAL, rule_id TEXT, reason TEXT, project_cwd TEXT
    );
    CREATE TABLE IF NOT EXISTS deferred (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL,
      session_id TEXT NOT NULL, tool TEXT NOT NULL, input TEXT NOT NULL,
      command TEXT, path TEXT, decisions_id INTEGER NOT NULL,
      reviewed INTEGER DEFAULT 0, final TEXT, review_ts INTEGER
    );
  `)
  const dr = db.prepare(
    'INSERT INTO decisions (ts,session_id,tool,input,command,path,decision,source,project_cwd) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(Date.now(), 's1', 'Bash', '{"command":"rm -rf dist/"}', 'rm -rf dist/', null, 'defer', 'auto_defer', '/test')
  const qr = db.prepare(
    'INSERT INTO deferred (ts,session_id,tool,input,command,path,decisions_id) VALUES (?,?,?,?,?,?,?)'
  ).run(Date.now(), 's1', 'Bash', '{"command":"rm -rf dist/"}', 'rm -rf dist/', null, dr.lastInsertRowid)
  db.close()
  return qr.lastInsertRowid
}

test('status prints current AFK state without crashing', async () => {
  const out = await run(['status'], makeEnv())
  assert.ok(out.includes('AFK mode:'), 'should include AFK mode line')
})

test('on enables AFK and prints confirmation', async () => {
  const env = makeEnv()
  const out = await run(['on'], env)
  assert.ok(out.includes('ON'), 'output should mention ON')
})

test('off disables AFK and prints digest', async () => {
  const env = makeEnv()
  await run(['on'], env)           // turn on first
  const out = await run(['off'], env)
  assert.ok(out.includes('AFK mode: OFF'), 'should confirm AFK is off')
  assert.ok(out.includes('AFK session digest') || out.includes('No activity'), 'should show digest or no-activity message')
})

test('resolve with existing id prints resolved confirmation', async () => {
  const env = makeEnv()
  const id = insertTestDeferredItem(env.AFK_DB_DIR)
  const out = await run(['resolve', String(id), 'allow'], env)
  assert.ok(out.includes(`Resolved [id=${id}]: allow.`), 'should print resolution confirmation')
})

test('resolve with non-existent id prints not-found message', async () => {
  const env = makeEnv()
  const out = await run(['resolve', '99999', 'allow'], env)
  assert.ok(out.includes('No pending item with id 99999'), 'should report missing id')
})
```

- [ ] **Step 7.2: Run to verify they fail**

```bash
node --test test/afk-cli.test.js
```

Expected: `Error: spawn node ... ENOENT` or similar (CLI file doesn't exist yet).

- [ ] **Step 7.3: Create `scripts/afk-cli.js`**

```js
#!/usr/bin/env node
// scripts/afk-cli.js — invoked by /afk slash command via Claude's Bash tool
import { isAfk, setAfk, getAndClearDigest, getState } from '../src/afk/state.js'
import { getPendingItems, resolveItem } from '../src/store/queue.js'
import { buildDigest } from '../src/afk/digest.js'

/**
 * Parses a duration string like "30m", "2h", "1h30m" into minutes.
 * @param {string} str
 * @returns {number|null} minutes, or null if not a valid duration
 */
function parseDuration(str) {
  const hours = Number(str.match(/(\d+)h/)?.[1] ?? 0)
  const mins  = Number(str.match(/(\d+)m/)?.[1] ?? 0)
  const total = hours * 60 + mins
  return total > 0 ? total : null
}

function formatTs(ms) {
  return new Date(ms).toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', hour12: false
  })
}

function formatDateTime(ms) {
  const d = new Date(ms)
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return `${date} ${formatTs(ms)}`
}

const [, , subcmd, ...rest] = process.argv

try {
  if (subcmd === 'on') {
    setAfk(true)
    process.stdout.write('AFK mode: ON\nClaude will handle safe permissions automatically.\n')

  } else if (subcmd === 'off') {
    if (!isAfk()) {
      process.stdout.write('AFK mode is already off.\n')
    } else {
      setAfk(false)
    }
    const entries = getAndClearDigest()
    const pendingItems = getPendingItems()
    const pendingCount = pendingItems.length
    process.stdout.write('AFK mode: OFF\n\n')
    process.stdout.write(buildDigest(entries, pendingCount) + '\n')
    if (pendingItems.length > 0) {
      process.stdout.write(`\nPending deferred actions (${pendingItems.length}):\n`)
      for (const item of pendingItems) {
        const label = item.command ?? item.path ?? item.tool
        process.stdout.write(`  [id=${item.id}] ${item.tool}: ${label}           ts: ${formatDateTime(item.ts)}\n`)
      }
      process.stdout.write('\nTo resolve: node scripts/afk-cli.js resolve <id> allow|deny\n')
    }

  } else if (subcmd === 'status') {
    const afkOn = isAfk()
    const pendingCount = getPendingItems().length
    if (afkOn) {
      const state = getState()
      const since = state.afk_since ? formatTs(state.afk_since) : '?'
      const until = state.afk_until ? `, auto-returns at ${formatTs(state.afk_until)}` : ''
      const autoApproved = (state.digest ?? []).filter(e => e.decision === 'allow').length
      process.stdout.write(`AFK mode: ON (since ${since}${until})\nPending deferred: ${pendingCount} actions\nSession digest: ${autoApproved} auto-approved since AFK started\n`)
    } else {
      const state = getState()
      const mins = state.auto_afk_minutes ?? 15
      const autoAfkStatus = mins === 0 ? 'disabled' : `enabled (triggers after ${mins} min idle)`
      process.stdout.write(`AFK mode: OFF\nPending deferred: ${pendingCount} actions\nAuto-AFK: ${autoAfkStatus}\n`)
    }

  } else if (subcmd === 'resolve') {
    const id = parseInt(rest[0], 10)
    const final = rest[1]
    if (isNaN(id) || !['allow', 'deny'].includes(final)) {
      process.stdout.write('Usage: node scripts/afk-cli.js resolve <id> allow|deny\n')
    } else {
      const updated = resolveItem(id, final)
      if (!updated) {
        process.stdout.write(`No pending item with id ${id}.\n`)
      } else {
        process.stdout.write(`Resolved [id=${id}]: ${final}.\n`)
      }
    }

  } else {
    // Check if it looks like a duration (30m, 2h, 1h30m)
    // Note: The spec's parseDuration section has a parenthetical "(treated as 'on' with no duration)"
    // for `abc → null`. This plan follows the spec's explicit Error Handling rule instead:
    // "Unknown subcommand → print usage to stdout, exit 0." The parenthetical describes the
    // internal meaning of null (no time limit), not the CLI behavior for unrecognised words.
    const mins = subcmd ? parseDuration(subcmd) : null
    if (mins !== null) {
      setAfk(true, mins)
      process.stdout.write(`AFK mode: ON for ${mins} minutes\n`)
    } else if (subcmd) {
      process.stdout.write('Usage: /afk [on|off|status|30m|2h|1h30m|resolve <id> allow|deny]\n')
    } else {
      // No arg: show status
      const afkOn = isAfk()
      const pendingCount = getPendingItems().length
      process.stdout.write(`AFK mode: ${afkOn ? 'ON' : 'OFF'}\nPending deferred: ${pendingCount} actions\n`)
    }
  }
} catch (err) {
  process.stderr.write(`afk-cli error: ${err.message}\n`)
  process.stdout.write(`Error running AFK command: ${err.message}\n`)
}
```

- [ ] **Step 7.4: Run to verify they pass**

```bash
node --test test/afk-cli.test.js
```

Expected: all 5 tests pass.

- [ ] **Step 7.5: Smoke-test the CLI manually**

```bash
node scripts/afk-cli.js status
node scripts/afk-cli.js on
node scripts/afk-cli.js status
node scripts/afk-cli.js off
node scripts/afk-cli.js resolve 999 allow
```

Expected output: no errors, sensible text for each command.

- [ ] **Step 7.6: Run full suite**

```bash
node --test test/*.test.js
```

Expected: all tests pass.

- [ ] **Step 7.7: Commit**

```bash
git add scripts/afk-cli.js test/afk-cli.test.js
git commit -m "feat: /afk CLI script (scripts/afk-cli.js)"
```

---

### Task 8: `commands/afk.md` — slash command prompt

**Files:**
- Create: `commands/afk.md`

No tests needed — this is a markdown prompt file for Claude Code's slash command system.

- [ ] **Step 8.1: Create `commands/afk.md`**

```markdown
---
name: afk
description: Toggle AFK mode on/off, set a duration, or check status
---

Run the AFK CLI with the user's argument:

```bash
SCRIPT="${PLUGIN_DIR}/scripts/afk-cli.js"
if [ -z "$PLUGIN_DIR" ] || [ ! -f "$SCRIPT" ]; then
  SCRIPT="$(git rev-parse --show-toplevel 2>/dev/null)/scripts/afk-cli.js"
fi
node "$SCRIPT" <arg>
```

Where `<arg>` is exactly what the user typed after `/afk` (e.g. `on`, `off`, `30m`, `status`).
If the user typed `/afk` with no argument, use `status`.

Read the output and present it clearly to the user.

If the output lists pending deferred items, ask the user to approve or deny each one.
For each decision, run: `node "$SCRIPT" resolve <id> allow|deny`
Confirm each resolution to the user as you go.
```

- [ ] **Step 8.2: Run full suite one final time**

```bash
node --test test/*.test.js
```

Expected: all tests pass (71 original + 20 new = 91 total, ± the updated chain test).

- [ ] **Step 8.3: Commit**

```bash
git add commands/afk.md
git commit -m "feat: /afk slash command prompt (commands/afk.md)"
```

---

## Verification

After all tasks are done, run the full test suite and confirm test count:

```bash
node --test test/*.test.js 2>&1 | tail -5
```

Expected output (approximately):
```
# tests 94
# pass  94
# fail  0
```
(71 existing + 2 state.js + 4 queue + 4 snapshot + 5 detector + 5 digest + 3 chain additions + 5 afk-cli = 94 total)

Final git log to confirm all commits landed cleanly:

```bash
git log --oneline -10
```
