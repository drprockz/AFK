# Phase 4 — Anomaly Detection Design

**Date:** 2026-03-17
**Phase:** 4 of 7
**Goal:** Detect statistically unusual PermissionRequests and interrupt the user (or defer to queue in AFK mode) before the behaviour predictor runs.

---

## Context

The `baselines` table and `updateBaseline` / `extractPattern` functions already exist in `src/store/history.js`. The `hook.js` entry point already calls `updateBaseline(request)` unconditionally after `chain()` returns (implemented in Phase 1+2). `chain.js` has a placeholder comment at Step 5 where the anomaly check belongs.

Phase 4 requires three changes:
1. Export `extractPattern` from `history.js` (currently module-private, needed by `anomaly.js`).
2. Create `src/engine/anomaly.js` — the scorer.
3. Replace the Step 5 placeholder in `chain.js` with a real `detectAnomaly()` call.

No changes to `hook.js` or `db.js` are needed.

---

## Step Order Note

The existing `chain.js` runs static rules (Step 4) **before** anomaly detection (Step 5). This is a deliberate deviation from CLAUDE.md's original ordering (which lists anomaly as Step 4 and rules as Step 5). The inversion is intentional: a request that matches an explicit user-defined rule should resolve immediately without paying the DB cost of an anomaly lookup, and rule matches carry stronger intent than anomaly scores. This ordering is canonical for Phase 4 and forward.

---

## File Map

| File | Change | Responsibility |
|------|--------|----------------|
| `src/store/history.js` | **modify** | Add `export` keyword to `extractPattern` so it can be imported by `anomaly.js` |
| `src/engine/anomaly.js` | **create** | Pure read-only scorer — reads `baselines` table, applies frequency tiers + outside-cwd check, returns `{ anomalous, score, reason }` |
| `src/engine/chain.js` | **modify** | Import `detectAnomaly`; replace Step 5 placeholder with real call; add AFK-ON defer path and AFK-OFF ask path |
| `test/anomaly.test.js` | **create** | 7 unit tests seeding the baselines table directly |
| `test/chain.test.js` | **modify** | 2 new tests: anomaly + AFK-OFF → ask, anomaly + AFK-ON → queue grows |

---

## `src/store/history.js` — export `extractPattern`

Change line 96 from:
```js
function extractPattern(request) {
```
to:
```js
export function extractPattern(request) {
```

No other changes to `history.js`. The function body and behaviour are unchanged.

---

## `src/engine/anomaly.js`

### Function signature

```js
export function detectAnomaly(request)
// request: { tool, input, cwd }
// returns: { anomalous: boolean, score: number, reason: string }
```

### Pattern extraction

Imports and calls `extractPattern` from `'../store/history.js'`:
```js
import { extractPattern } from '../store/history.js'
```

`extractPattern` behaviour (for reference — do not duplicate):
- Bash: first two words of command — e.g. `"npm run test:unit --watch"` → `"npm run"`
- File tools (Write/Read/Edit etc.): strips filename, keeps directory path + `/*` — e.g. `"/home/darshan/project/src/Button.tsx"` → `"/home/darshan/project/src/*"`
- Other tools: returns the tool name itself

The baseline lookup key is `(project_cwd, tool, pattern)` — identical to what `updateBaseline` writes, ensuring reads and writes use the same key format.

### Frequency signal

Query: `SELECT count FROM baselines WHERE project_cwd = ? AND tool = ? AND pattern = ?`

| count | score | label |
|-------|-------|-------|
| row not found | 1.0 | "never seen in this project" |
| 1–2 | 0.7 | "seen rarely (N times)" |
| 3–9 | 0.3 | "seen occasionally (N times)" |
| ≥ 10 | 0.0 | "common pattern" |

Boundary clarification: count=2 → score 0.7 (rarely seen); count=3 → score 0.3 (occasionally seen); count=9 → score 0.3; count=10 → score 0.0.

### Outside-cwd signal (Bash only)

Applied after the frequency score is computed.

Suspicious prefixes — absolute paths that are not inside `cwd`:
```js
const SUSPICIOUS_PREFIXES = ['/etc/', '/usr/', '/var/', '/root/', '/home/', '/tmp/', '~/']
```

Note: `/home/` is intentionally broad. A cross-project command like accessing `/home/user/other-project/` from within a different project will trigger this check. This is acceptable in Phase 4 — false positives for cross-project operations are a known trade-off, not a bug.

Check: split `input.command` on whitespace into tokens. For each token, check if it starts with a suspicious prefix AND does not start with `cwd`. If any such token is found:
- `score = Math.max(score, 0.8)`
- Append to reason: `"accesses path outside project: <matched token>"`

### Anomaly threshold

```js
const ANOMALY_THRESHOLD = 0.7
anomalous = score >= ANOMALY_THRESHOLD
```

Matches `thresholds.anomalyFlag: 0.7` in the default config.

### Error handling

The entire function body is wrapped in try/catch. On any DB or logic error:
```js
return { anomalous: false, score: 0, reason: 'anomaly check skipped (error)' }
```
This ensures `detectAnomaly` never blocks the chain.

---

## `src/engine/chain.js` — Step 5 wiring

Add import at top:
```js
import { detectAnomaly } from './anomaly.js'
```

Replace the current Step 5 placeholder comment block with:

```js
// ── Step 5: Anomaly detector ──────────────────────────────────────────────
const anomaly = detectAnomaly({ tool, input, cwd })
if (anomaly.anomalous) {
  if (afkOn) {
    // AFK-ON: log as defer, enqueue, appendDigest — no snapshot (not destructive)
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

Key points:
- `logDecision` called directly (not via `log()`) in the AFK-ON branch to capture `lastInsertRowid` for the FK.
- No `snapshot()` call — anomalies are suspicious but not necessarily destructive. Snapshot remains exclusive to the destructive classifier path.
- The AFK-ON branch returns early (before the predictor) — same pattern as the destructive defer path in Step 3.

---

## Decision flow after Phase 4

```
Step 1  Sensitive path guard    → always ask (no change)
Step 2  Prompt injection        → deny (no change)
Step 3  Destructive classifier  → defer/ask (no change)
Step 4  Static rules            → allow/deny (no change)
Step 5  Anomaly detector        → NEW: defer (AFK-ON) or ask (AFK-OFF) if anomalous
Step 6  Behaviour predictor     → allow/deny if confidence ≥ 0.85 or ≤ 0.15
Step 7  AFK fallback            → auto-allow (AFK-ON) or ask
```

Non-anomalous requests pass through Step 5 silently to Step 6.

---

## Testing

### `test/anomaly.test.js`

All tests use isolated `AFK_DB_DIR`. Baselines are seeded directly via `getDb().prepare(...).run(...)` — no chain involvement.

| # | Test | Setup | Expected |
|---|------|-------|----------|
| 1 | never-seen pattern | no baseline row | `anomalous=true, score=1.0` |
| 2 | count=1 (rarely seen) | baseline count=1 | `anomalous=true, score=0.7` |
| 3 | count=2 (rarely seen, boundary) | baseline count=2 | `anomalous=true, score=0.7` |
| 4 | count=5 (occasionally seen) | baseline count=5 | `anomalous=false, score=0.3` |
| 5 | count=10 (common, boundary) | baseline count=10 | `anomalous=false, score=0.0` |
| 6 | outside-cwd Bash command | baseline count=10, cmd contains `/etc/hosts` | `anomalous=true, score=0.8` |
| 7 | DB error — never throws | Run as last test: call `getDb().close()` to close the singleton connection, then call `detectAnomaly` | `anomalous=false, score=0` and no exception thrown |

Test 7 detail: `getDb()` is a module-level singleton. Calling `.close()` on it closes the underlying SQLite connection. The next `detectAnomaly` call will attempt `.prepare(...)` on the closed connection, which throws — exercising the outer try/catch. This test MUST be last in the file since it permanently corrupts the singleton for that test process.

### `test/chain.test.js` additions

Two new tests appended after the existing suite:

```
test('never-seen pattern + AFK-OFF → ask with anomaly reason')
  setAfk(false)
  chain({ tool: 'Bash', input: { command: 'zz-anomaly-xyzzy-never-seen' }, ... })
  assert behavior === 'ask'

test('never-seen pattern + AFK-ON → ask + deferred queue grows')
  setAfk(true)
  const before = getPendingItems().length
  chain({ tool: 'Bash', input: { command: 'zz-anomaly-xyzzy-never-seen-2' }, ... })
  assert behavior === 'ask'
  assert getPendingItems().length > before
  setAfk(false)
```

The command strings `'zz-anomaly-xyzzy-never-seen'` and `'zz-anomaly-xyzzy-never-seen-2'` are sufficiently exotic to guarantee no matching baseline row exists in the chain test DB, producing score=1.0 (anomalous). Use distinct strings for each test to avoid cross-test interference from `updateBaseline`.

---

## Error Handling Summary

| Scenario | Behaviour |
|----------|-----------|
| `detectAnomaly` DB error | Returns `anomalous=false` — chain continues to predictor |
| `logDecision` throws in AFK-ON defer path | Caught, `decisionsId` is undefined, `enqueueDeferred` skipped — still returns ask |
| `enqueueDeferred` throws | Caught, non-fatal — still returns ask and appends digest |
| `updateBaseline` throws (in hook.js) | Already caught — non-fatal, chain result is already written |

---

## Out of Scope for Phase 4

- Phone/Telegram notifications on anomaly (Phase 5)
- Dashboard display of anomaly scores (Phase 6)
- Configurable `anomalyFlag` threshold from `config.json` (currently hardcoded to 0.7 — Phase 7 polish)
- Full bash command tokenisation / argument parsing for outside-cwd check
