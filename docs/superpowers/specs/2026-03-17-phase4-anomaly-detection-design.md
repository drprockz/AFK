# Phase 4 — Anomaly Detection Design

**Date:** 2026-03-17
**Phase:** 4 of 7
**Goal:** Detect statistically unusual PermissionRequests and interrupt the user (or defer to queue in AFK mode) before the behaviour predictor runs.

---

## Context

The `baselines` table and `updateBaseline` / `extractPattern` functions already exist in `src/store/history.js` and `src/hook.js`. The `hook.js` entry point already calls `updateBaseline(request)` unconditionally after `chain()` returns (implemented in Phase 1+2). `chain.js` has a placeholder comment at Step 5 where the anomaly check belongs.

Phase 4 is therefore two changes:
1. Create `src/engine/anomaly.js` — the scorer.
2. Replace the Step 5 placeholder in `chain.js` with a real `detectAnomaly()` call.

No changes to `hook.js`, `db.js`, or `history.js` are needed.

---

## File Map

| File | Change | Responsibility |
|------|--------|----------------|
| `src/engine/anomaly.js` | **create** | Pure read-only scorer — reads `baselines` table, applies frequency tiers + outside-cwd check, returns `{ anomalous, score, reason }` |
| `src/engine/chain.js` | **modify** | Replace Step 5 placeholder with `detectAnomaly()` call; add AFK-ON defer path and AFK-OFF ask path |
| `test/anomaly.test.js` | **create** | 6 unit tests seeding the baselines table directly |
| `test/chain.test.js` | **modify** | 2 new tests: anomaly + AFK-OFF → ask, anomaly + AFK-ON → queue grows |

---

## `src/engine/anomaly.js`

### Function signature

```js
export function detectAnomaly(request)
// request: { tool, input, cwd }
// returns: { anomalous: boolean, score: number, reason: string }
```

### Pattern extraction

Uses the same `extractPattern` logic already in `history.js` (imported and reused):
- Bash: first two words of command — e.g. `"npm run test:unit --watch"` → `"npm run"`
- File tools: directory path + `/*` — e.g. `"/home/darshan/project/src/Button.tsx"` → `"src/components/*"`
- Other tools: tool name itself

The baseline lookup key is `(project_cwd, tool, pattern)` — identical to what `updateBaseline` writes.

### Frequency signal

Query: `SELECT count FROM baselines WHERE project_cwd = ? AND tool = ? AND pattern = ?`

| count | score | label |
|-------|-------|-------|
| row not found (0) | 1.0 | "never seen in this project" |
| 1–2 | 0.7 | "seen rarely (N times)" |
| 3–9 | 0.3 | "seen occasionally (N times)" |
| ≥ 10 | 0.0 | "common pattern" |

### Outside-cwd signal (Bash only)

Applied after the frequency score is computed.

Suspicious prefixes (absolute paths that are not inside `cwd`):
```js
const SUSPICIOUS_PREFIXES = ['/etc/', '/usr/', '/var/', '/root/', '/home/', '/tmp/', '~/']
```

Check: scan `input.command` for any token that starts with a suspicious prefix AND does not start with `cwd`. If found:
- `score = Math.max(score, 0.8)`
- Append to reason: `"accesses path outside project: <matched prefix>"`

The check is a simple substring scan — no full bash parsing. String tokens are split on whitespace.

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

Replace the current placeholder comment block with:

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
- The AFK-ON branch returns early (before the predictor) — same pattern as the destructive defer path.

New import added to `chain.js`:
```js
import { detectAnomaly } from './anomaly.js'
```

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

| Test | Setup | Expected |
|------|-------|----------|
| never-seen pattern | no baseline row | `anomalous=true, score=1.0` |
| count=1 (rarely seen) | baseline count=1 | `anomalous=true, score=0.7` |
| count=2 (rarely seen) | baseline count=2 | `anomalous=true, score=0.7` |
| count=5 (occasional) | baseline count=5 | `anomalous=false, score=0.3` |
| count=10 (common) | baseline count=10 | `anomalous=false, score=0.0` |
| outside-cwd Bash command | count=10, cmd contains `/etc/hosts` | `anomalous=true, score=0.8` |
| DB failure (corrupt dir) | invalid AFK_DB_DIR | `anomalous=false, score=0` (no throw) |

### `test/chain.test.js` additions

Two new tests appended after the existing suite:

```
test('never-seen pattern + AFK-OFF → ask with anomaly reason')
  setAfk(false)
  chain({ tool: 'Bash', input: { command: 'exotic-tool --flag' }, ... })
  assert behavior === 'ask'

test('never-seen pattern + AFK-ON → ask + deferred queue grows')
  setAfk(true)
  const before = getPendingItems().length
  chain({ tool: 'Bash', input: { command: 'exotic-tool --flag' }, ... })
  assert behavior === 'ask'
  assert getPendingItems().length > before
  setAfk(false)
```

Note: these tests must use a command that won't match any existing baseline in the chain test DB. A sufficiently exotic command string (e.g. `'zz-test-anomaly-xyzzy'`) guarantees a fresh baseline.

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
