# AFK Core Design — Hook, Schema, Chain

**Date:** 2026-03-16
**Scope:** Hook entry point, SQLite schema corrections, fallback chain order
**Status:** Approved

---

## Context

AFK is a Claude Code plugin that intercepts every `PermissionRequest` via a stdin/stdout hook. This document captures design decisions made during brainstorming for three specific areas where the CLAUDE.md spec had gaps or contradictions.

---

## 1. Hook Entry Point (`src/hook.js`)

### Problem

The spec did not enforce an internal timeout. Claude Code kills hook processes after ~30 seconds. The notification config allows `timeout: 120` — a 4× overage that guarantees a killed process.

### Decision: Hard 25-second global deadline

The hook computes a `deadline` timestamp on startup and passes it to `chain()`. It also races the chain call against a 25-second timeout. If the chain has not resolved by then, the hook returns `ask` and exits cleanly.

```js
const HARD_DEADLINE_MS = 25_000

process.stdin.on('end', async () => {
  try {
    const request = JSON.parse(input)
    if (!request?.tool) throw new Error('malformed input')

    const deadline = Date.now() + HARD_DEADLINE_MS
    const result = await Promise.race([
      chain(request, deadline),
      new Promise(resolve =>
        setTimeout(() => resolve({ behavior: 'ask', reason: 'timeout' }), HARD_DEADLINE_MS)
      )
    ])
    process.stdout.write(JSON.stringify({ behavior: result.behavior }))
    process.exit(0)
  } catch (err) {
    process.stderr.write(`afk error: ${err.message}\n`)
    process.stdout.write(JSON.stringify({ behavior: 'ask' }))
    process.exit(0)
  }
})
```

`chain(request, deadline)` accepts the deadline as its second argument. Each blocking step inside the chain (notifications, dashboard queue) computes its allowed wait as:

```js
const remaining = deadline - Date.now()
if (remaining <= 2000) {
  // Insufficient budget — skip blocking step, return ask immediately
  return { behavior: 'ask', reason: 'deadline' }
}
const waitMs = Math.min(config.notifications.timeout * 1000, remaining - 2000)
```

If `remaining <= 2000` at the start of any blocking step, the step is skipped and the chain returns `ask` immediately. The `-2000` buffer on `waitMs` leaves 2 seconds for chain teardown before the outer deadline fires.

The `config.notifications.timeout` is the user's preference for when they're present at the computer — not the hook's hard limit.

### Snapshot awaiting

`snapshot()` in `src/safety/snapshot.js` is an `async` function and must be `await`ed by the chain before returning the defer decision. The word "synchronously" in CLAUDE.md's snapshot description is incorrect — `snapshot()` executes shell commands and is inherently async. Its execution time counts against the deadline budget.

### Input validation

Before entering the chain, the hook validates:
- `input` is non-empty
- Parsed JSON has a `tool` field

Malformed payloads return `ask` immediately without entering the chain.

---

## 2. SQLite Schema Corrections

### Problem A: `decisions.input` stores full input JSON, but Write/Edit can contain huge file content

The spec says "never store full file content in decisions table" — but the schema's `input TEXT NOT NULL` would store it all if not handled explicitly.

### Decision: Sanitize input before storage, raw input for deferred queue

A `sanitizeInput(tool, input)` function in `src/store/history.js` runs only at the point of inserting into `decisions`. The chain always operates on the original unsanitized input object — sanitization is a storage-layer concern only.

```js
function sanitizeInput(tool, input) {
  if (tool === 'Write')
    return { file_path: input.file_path }
  if (tool === 'Edit')
    // new_string is intentionally omitted — may be arbitrarily large.
    // file_path + truncated old_string are sufficient for audit purposes.
    // Full content is available in deferred.input for review queue items.
    return { file_path: input.file_path, old_string: input.old_string?.slice(0, 500) }
  if (tool === 'MultiEdit')
    return { file_path: input.file_path, edits_count: input.edits?.length }
  return input  // Bash, Read, Glob, Grep — small, store as-is
}
```

The `decisions.input` column comment in CLAUDE.md (`-- full input JSON (stringified)`) is superseded. The correct comment is `-- sanitized input JSON (content fields stripped for Write/Edit)`.

`decisions.path` and `decisions.command` are extracted from the original input before sanitization. `decisions.input` stores the sanitized JSON.

The `deferred` table stores the **original raw input** — the deferred queue is used for human review, so reviewers need full context (e.g., the actual file content being written). The intent of "never store full file content" applies only to the permanent audit log (`decisions`), not the mutable review queue (`deferred`).

### Problem B: Missing index for predictor queries

The predictor queries `decisions` filtered by `project_cwd + tool + pattern`. Without an index on `project_cwd`, this scans all decisions across all projects.

### Decision: Add project-scoped index

```sql
CREATE INDEX IF NOT EXISTS idx_decisions_project ON decisions(project_cwd, tool);
```

### Problem C: `deferred` and `decisions` double-counting

The spec has both tables but doesn't clarify the relationship. Naive implementation would log the same action twice.

### Decision: Deferred = queue view, decisions = permanent log, reviews logged as new rows

A deferred action is logged **once** in `decisions` with `decision='defer'` and `source='auto_defer'`. It is also inserted into `deferred` as the review queue entry, with a `decisions_id` column referencing the originating `decisions.id`.

When a user reviews a deferred item (via dashboard `POST /api/queue/:id` or notification response), two writes occur:
1. `deferred` row is updated: `reviewed=1`, `final='allow'|'deny'`, `review_ts=now`
2. A **new** `decisions` row is inserted with `decision='allow'|'deny'`, `source='user'`, using the same `tool`, sanitized `input`, `path`, `command`, and `session_id` as the original

A reviewed deferral therefore appears twice in `decisions`: once as `decision='defer'` (the original capture) and once as `decision='allow'|'deny'` (the review outcome). Stats queries must account for this:
- Deferral counts: filter `decision='defer'`
- Final outcome counts: exclude `decision='defer'` rows

The `deferred` table requires one additional column beyond CLAUDE.md:
```sql
decisions_id INTEGER NOT NULL  -- FK to decisions.id of the originating defer row
```

### Decision: Extended `source` enum

The `decisions.source` column (CLAUDE.md: `-- user | rule | prediction | auto_afk`) is extended. The corrected DDL comment is `-- user | rule | prediction | auto_afk | auto_defer`.

| Value | Meaning |
|---|---|
| `user` | User approved/denied manually (including post-deferral review) |
| `rule` | Matched a static rule |
| `prediction` | Auto-decided by behavior predictor |
| `auto_afk` | Auto-approved by AFK fallback |
| `auto_defer` | Deferred by classifier or anomaly detector |

### Anomaly scoring: gap in 3–9 occurrence range

CLAUDE.md defines scores for 0, 1–2, and 10+ occurrences but leaves 3–9 undefined. The corrected scoring table:

| Occurrences | `anomaly_score` |
|---|---|
| 0 | 1.0 |
| 1–2 | 0.7 |
| 3–9 | `max(0, 0.7 - (count - 2) * 0.1)` — linear decay from 0.6 to 0.0 |
| 10+ | 0.0 |

No pattern in the 3–9 range will exceed the 0.7 flag threshold (`config.thresholds.anomalyFlag`), so these requests pass through to the predictor.

---

## 3. Corrected Fallback Chain (`src/engine/chain.js`)

### Problem A: Static rules came after anomaly detection

A user rule ("always allow `npm run test`") would be ignored if the pattern had never been seen in the current project — anomaly score 1.0 would trigger a deferral before the rule fired. Static rules express explicit user intent and must win over automated inference.

### Problem B: Steps 8–9 (notifications, dashboard) were unreachable

Step 7 (AFK fallback) returned immediately — either auto-approve or `ask`. Steps 8 and 9 were never reachable. Notifications and the dashboard queue need to be integrated as branches within the AFK fallback step.

### Decision: Corrected chain order

```
Step 1 — Sensitive path guard
  Match + AFK ON  → fire-and-forget urgent notification, return ask
  Match + AFK OFF → return ask

Step 2 — Prompt injection
  Match → deny immediately, log reason

Step 3 — Destructive classifier
  Match + AFK ON  → snapshot (git commit), enqueue to deferred (source=auto_defer), return ask
  Match + AFK OFF → return ask (Claude Code prompts user)

Step 4 — Static rules           [MOVED: was step 5]
  Match found → apply rule decision (source=rule), return
  No match    → continue

Step 5 — Anomaly detector       [MOVED: was step 4]
  Anomaly + AFK ON  → fire-and-forget notification, enqueue to deferred (source=auto_defer), return ask
  Anomaly + AFK OFF → return ask with anomaly explanation
  No anomaly        → continue to step 6

Step 6 — Behavior predictor
  confidence > 0.85 → auto-decide (source=prediction), return
  confidence < 0.15 → auto-deny (source=prediction), return
  0.15–0.85         → escalate to step 7

Step 7 — Smart AFK fallback     [MERGED: was steps 7 + 8 + 9]
  AFK ON                           → auto-approve (source=auto_afk), append to digest, return allow
  AFK OFF + notifications          → compute waitMs; if waitMs <= 0 return ask
                                     race(phone/telegram response, waitMs)
    Response received              → apply decision (source=user), return
    Timeout                        → compute remaining; if remaining <= 2000 return ask
                                     race(dashboard queue response, remaining - 2000)
      Response received            → apply decision (source=user), return
      Timeout                      → fail closed → return ask
  AFK OFF + no notifications       → return ask
```

### Baseline upsert timing

The baseline upsert (anomaly detector's `upsert baselines` from CLAUDE.md) is a **post-chain side effect**, not inline within step 5. After `chain()` returns any decision, the hook calls `updateBaseline(request)` unconditionally. This ensures the baseline reflects the final decision regardless of which chain step produced it.

### Notification side-effects vs blocking

Steps 1, 3, and 5 send notifications as **fire-and-forget** in AFK mode — they do not block the return. Step 7 is the **only** step that awaits a notification response, and only when AFK mode is OFF and notifications are configured.

---

## Summary of Changes from CLAUDE.md Spec

| Area | Spec | Corrected Design |
|---|---|---|
| Hook timeout | Not enforced | Hard 25s deadline via `chain(request, deadline)` |
| `chain()` signature | Not specified | `chain(request, deadline)` — deadline propagated to blocking steps |
| `waitMs <= 0` case | Not handled | Skip blocking step, return `ask` immediately |
| `snapshot()` async | Described as "synchronous" | Is `async`, must be `await`ed; counts against deadline budget |
| Input storage | Full JSON including content | Sanitized in `history.js` before `decisions` insert only |
| `decisions.input` comment | `-- full input JSON` | `-- sanitized input JSON (content fields stripped for Write/Edit)` |
| `Edit` `new_string` | Implicitly stored | Intentionally omitted; full content in `deferred.input` |
| `deferred.input` | Not specified | Raw original input (for human review context) |
| `deferred` → `decisions` link | Not specified | `deferred.decisions_id` FK; reviews log new `decisions` row with `source='user'` |
| Stats double-counting | Not addressed | Deferral counts use `decision='defer'`; outcome counts exclude it |
| Project index | Missing | `idx_decisions_project ON decisions(project_cwd, tool)` |
| `source` enum | 4 values, comment outdated | 5 values: adds `auto_defer`; DDL comment updated |
| Anomaly score 3–9 range | Undefined | Linear decay: `max(0, 0.7 - (count-2) * 0.1)` |
| Chain step 4 | Anomaly | Static rules |
| Chain step 5 | Static rules | Anomaly (with explicit `continue` on non-anomalous path) |
| Chain steps 8–9 | Unreachable | Merged into step 7, branched on AFK ON / AFK OFF |
| Baseline upsert | Inline in step 5 | Post-chain side effect, called after chain returns |
