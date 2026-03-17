# Phase 4 — Anomaly Detection Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `src/engine/anomaly.js` to detect statistically unusual PermissionRequests and wire it into the chain at Step 5 (after static rules, before the behaviour predictor).

**Architecture:** Three changes: (1) export `extractPattern` from `history.js` so `anomaly.js` can reuse it; (2) create `anomaly.js` as a pure read-only scorer that checks the `baselines` table frequency tiers and scans Bash commands for outside-cwd paths; (3) replace the Step 5 placeholder in `chain.js` with a real `detectAnomaly()` call that defers to queue (AFK-ON) or interrupts the user (AFK-OFF) when an anomaly is detected.

**Tech Stack:** Node.js 18+ ESM, `better-sqlite3` (sync SQLite), `node:test` + `node:assert`.

---

## File Map

| File | Change | Responsibility |
|------|--------|----------------|
| `src/store/history.js` | **modify** (line 96) | Add `export` to `extractPattern` |
| `src/engine/anomaly.js` | **create** | Pure scorer: frequency tiers + outside-cwd check |
| `src/engine/chain.js` | **modify** | Import `detectAnomaly`; replace Step 5 placeholder |
| `test/anomaly.test.js` | **create** | 7 unit tests for the scorer |
| `test/chain.test.js` | **modify** | 2 new anomaly integration tests |

---

## Chunk 1: Export + Anomaly Scorer

### Task 1: Export `extractPattern` from `src/store/history.js`

**Files:**
- Modify: `src/store/history.js:96`

This is a one-word change. `extractPattern` is currently module-private and must be exported so `anomaly.js` can import it without duplicating logic.

- [ ] **Step 1.1: Make the change**

On line 96 of `src/store/history.js`, change:
```js
function extractPattern(request) {
```
to:
```js
export function extractPattern(request) {
```

No other changes. Function body is unchanged.

- [ ] **Step 1.2: Run full test suite to confirm no regressions**

```bash
node --test test/*.test.js
```

Expected: all 98 tests still pass. (`extractPattern` was previously only called internally by `updateBaseline` in the same file — the export is backward-compatible.)

- [ ] **Step 1.3: Commit**

```bash
git add src/store/history.js
git commit -m "feat: export extractPattern from history.js for anomaly.js reuse"
```

---

### Task 2: Create `src/engine/anomaly.js`

**Files:**
- Create: `src/engine/anomaly.js`
- Create: `test/anomaly.test.js`

- [ ] **Step 2.1: Write the failing tests** — create `test/anomaly.test.js`:

```js
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
```

- [ ] **Step 2.2: Run to verify they fail**

```bash
node --test test/anomaly.test.js
```

Expected: `Error: Cannot find module '../src/engine/anomaly.js'`

- [ ] **Step 2.3: Create `src/engine/anomaly.js`**

```js
// src/engine/anomaly.js
import { getDb } from '../store/db.js'
import { extractPattern } from '../store/history.js'

const ANOMALY_THRESHOLD = 0.7

const SUSPICIOUS_PREFIXES = ['/etc/', '/usr/', '/var/', '/root/', '/home/', '/tmp/', '~/']

/**
 * Detects whether a PermissionRequest is statistically anomalous for this project.
 * Checks the baselines table frequency and (for Bash) scans for outside-cwd paths.
 * Never throws — returns a safe fallback on any DB or logic error.
 * @param {object} request  — { tool, input, cwd }
 * @returns {{ anomalous: boolean, score: number, reason: string }}
 */
export function detectAnomaly(request) {
  try {
    const db = getDb()
    const pattern = extractPattern(request)
    const cwd = request.cwd ?? ''

    // ── Frequency signal ────────────────────────────────────────────────────
    const row = db.prepare(`
      SELECT count FROM baselines
      WHERE project_cwd = ? AND tool = ? AND pattern = ?
    `).get(cwd, request.tool, pattern)

    let score
    let reason
    if (!row) {
      score = 1.0
      reason = `never seen in this project (pattern: ${pattern})`
    } else if (row.count <= 2) {
      score = 0.7
      reason = `seen rarely (${row.count} time${row.count === 1 ? '' : 's'})`
    } else if (row.count <= 9) {
      score = 0.3
      reason = `seen occasionally (${row.count} times)`
    } else {
      score = 0.0
      reason = `common pattern (${row.count} times)`
    }

    // ── Outside-cwd signal (Bash only) ──────────────────────────────────────
    if (request.tool === 'Bash' && request.input?.command) {
      const tokens = request.input.command.split(/\s+/)
      for (const token of tokens) {
        const isSuspicious = SUSPICIOUS_PREFIXES.some(prefix => token.startsWith(prefix))
        const isInsideCwd = cwd && token.startsWith(cwd)
        if (isSuspicious && !isInsideCwd) {
          score = Math.max(score, 0.8)
          reason = `accesses path outside project: ${token}`
          break
        }
      }
    }

    return {
      anomalous: score >= ANOMALY_THRESHOLD,
      score,
      reason
    }
  } catch {
    return { anomalous: false, score: 0, reason: 'anomaly check skipped (error)' }
  }
}
```

- [ ] **Step 2.4: Run tests to verify they pass**

```bash
node --test test/anomaly.test.js
```

Expected: all 7 tests pass.

- [ ] **Step 2.5: Run full suite**

```bash
node --test test/*.test.js
```

Expected: all 105 tests pass (98 existing + 7 new). `node --test` runs each file in its own worker process, so the DB close in anomaly.test.js only affects that file's process.

- [ ] **Step 2.6: Commit**

```bash
git add src/engine/anomaly.js test/anomaly.test.js
git commit -m "feat: anomaly detector — frequency tiers + outside-cwd check (src/engine/anomaly.js)"
```

---

## Chunk 2: Chain Wiring

### Task 3: Wire `detectAnomaly` into `src/engine/chain.js`

**Files:**
- Modify: `src/engine/chain.js`
- Modify: `test/chain.test.js`

- [ ] **Step 3.1: Add 2 failing tests to `test/chain.test.js`**

Add at the bottom of `test/chain.test.js` (after the existing `'expired deadline → ask'` test):

```js
test('never-seen Bash command + AFK-OFF → ask with anomaly reason', async () => {
  setAfk(false)
  const r = await chain(
    { tool: 'Bash', input: { command: 'zz-anomaly-xyzzy-never-seen' }, session_id: 's1', cwd },
    deadline()
  )
  assert.strictEqual(r.behavior, 'ask')
  assert.ok(r.reason.toLowerCase().includes('unusual') || r.reason.toLowerCase().includes('anomal'),
    `reason should mention anomaly, got: ${r.reason}`)
})

test('never-seen Bash command + AFK-ON → ask + deferred queue grows', async () => {
  setAfk(true)
  const before = getPendingItems().length
  const r = await chain(
    { tool: 'Bash', input: { command: 'zz-anomaly-xyzzy-never-seen-2' }, session_id: 's1', cwd },
    deadline()
  )
  assert.strictEqual(r.behavior, 'ask')
  const after = getPendingItems().length
  assert.ok(after > before, `deferred queue should have grown (before=${before}, after=${after})`)
  setAfk(false)
})
```

Note: these tests use distinct command strings (`zz-anomaly-xyzzy-never-seen` and `zz-anomaly-xyzzy-never-seen-2`) that are exotic enough to guarantee no existing baseline row in the chain test DB. The `hook.js` `updateBaseline` call is not in scope here — chain.test.js calls `chain()` directly, so baselines are not updated between tests.

- [ ] **Step 3.2: Run chain tests to verify the 2 new tests fail**

```bash
node --test test/chain.test.js
```

Expected: 2 new tests fail (the chain still has the placeholder comment at Step 5 and passes through to the AFK fallback).

- [ ] **Step 3.3: Modify `src/engine/chain.js`**

**Add import** — at the top of `src/engine/chain.js`, after the existing imports, add:

```js
import { detectAnomaly } from './anomaly.js'
```

The full import block should look like:
```js
import { isSensitive } from './sensitive.js'
import { hasInjection } from './injection.js'
import { classify } from './classifier.js'
import { matchRule } from './rules.js'
import { predict } from './predictor.js'
import { detectAnomaly } from './anomaly.js'
import { isAfk, getSessionId, appendDigest } from '../afk/state.js'
import { logDecision } from '../store/history.js'
import { existsSync } from 'node:fs'
import { checkAndAutoAfk } from '../afk/detector.js'
import { snapshot } from '../safety/snapshot.js'
import { enqueueDeferred } from '../store/queue.js'
```

**Replace the Step 5 placeholder** — find these lines in `chain.js`:
```js
  // ── Step 5: Anomaly detector ──────────────────────────────────────────────
  // Phase 4 — placeholder, always passes through
  // anomaly detection wired in Phase 4 plan
```

Replace them with:
```js
  // ── Step 5: Anomaly detector ──────────────────────────────────────────────
  const anomaly = detectAnomaly({ tool, input, cwd })
  if (anomaly.anomalous) {
    if (afkOn) {
      // AFK-ON: log as defer, enqueue, appendDigest — no snapshot (not destructive)
      // logDecision called DIRECTLY (not via log()) to capture lastInsertRowid for FK
      let decisionsId
      try {
        decisionsId = logDecision({
          session_id, tool, input, command, path,
          decision: 'defer',
          source: 'auto_defer',
          project_cwd: cwd,
          reason: `Anomaly (score=${anomaly.score.toFixed(2)}): ${anomaly.reason}`
        })
      } catch { /* non-fatal */ }
      if (decisionsId != null) {
        try { enqueueDeferred({ decisionsId, sessionId: session_id, tool, input, command, path }) } catch { /* non-fatal */ }
      }
      appendDigest({ tool, command, path, decision: 'defer', ts: Date.now() })
      return { behavior: 'ask', reason: `Anomalous request deferred: ${anomaly.reason}` }
    } else {
      // AFK-OFF: interrupt user with explanation
      log('ask', 'chain', { reason: `Anomaly (score=${anomaly.score.toFixed(2)}): ${anomaly.reason}` })
      return { behavior: 'ask', reason: `Unusual request detected: ${anomaly.reason}` }
    }
  }
```

- [ ] **Step 3.4: Run chain tests to verify they all pass**

```bash
node --test test/chain.test.js
```

Expected: all 15 tests pass (13 existing + 2 new).

- [ ] **Step 3.5: Run full suite**

```bash
node --test test/*.test.js
```

Expected: all 107 tests pass (98 pre-Phase-4 + 7 anomaly + 2 chain additions).

- [ ] **Step 3.6: Commit**

```bash
git add src/engine/chain.js test/chain.test.js
git commit -m "feat: wire anomaly detector into chain Step 5 (AFK-ON defer, AFK-OFF ask)"
```

---

## Verification

After all tasks are done, confirm the final test count:

```bash
node --test test/*.test.js 2>&1 | tail -5
```

Expected:
```
# tests 107
# pass  107
# fail  0
```

Final git log:
```bash
git log --oneline -5
```

Expected to see 3 new commits from this phase:
```
<sha>  feat: wire anomaly detector into chain Step 5 (AFK-ON defer, AFK-OFF ask)
<sha>  feat: anomaly detector — frequency tiers + outside-cwd check (src/engine/anomaly.js)
<sha>  feat: export extractPattern from history.js for anomaly.js reuse
```
