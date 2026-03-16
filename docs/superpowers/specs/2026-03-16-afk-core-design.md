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

The hook wraps the entire chain call in `Promise.race` against a 25-second deadline. If the chain has not resolved by then, the hook returns `ask` and exits cleanly.

```js
const HARD_DEADLINE_MS = 25_000

process.stdin.on('end', async () => {
  try {
    const request = JSON.parse(input)
    if (!request?.tool) throw new Error('malformed input')

    const result = await Promise.race([
      chain(request),
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

### Time budget propagation

The hook passes a `deadline` timestamp to `chain()`. Each blocking step (notifications, dashboard queue) computes its allowed wait as:

```js
const remaining = deadline - Date.now()
const waitMs = Math.min(config.notifications.timeout * 1000, remaining - 2000)
```

The `config.notifications.timeout` is the user's preference for when they're present at the computer — not the hook's hard limit.

### Input validation

Before entering the chain, the hook validates:
- `input` is non-empty
- Parsed JSON has a `tool` field

Malformed payloads return `ask` immediately without entering the chain.

---

## 2. SQLite Schema Corrections

### Problem A: `decisions.input` stores full input JSON, but Write/Edit can contain huge file content

The spec says "never store full file content in decisions table" — but the schema's `input TEXT NOT NULL` would store it all if not handled explicitly.

### Decision: Sanitize input before storage

A `sanitizeInput(tool, input)` function runs before any `decisions` insert:

```js
function sanitizeInput(tool, input) {
  if (tool === 'Write')
    return { file_path: input.file_path }
  if (tool === 'Edit')
    return { file_path: input.file_path, old_string: input.old_string?.slice(0, 500) }
  if (tool === 'MultiEdit')
    return { file_path: input.file_path, edits_count: input.edits?.length }
  return input  // Bash, Read, Glob, Grep — small, store as-is
}
```

Path and command extraction for the `decisions.path` and `decisions.command` columns happens from the **original** input before sanitization.

### Problem B: Missing index for predictor queries

The predictor queries `decisions` filtered by `project_cwd + tool + pattern`. Without an index on `project_cwd`, this scans all decisions across all projects.

### Decision: Add project-scoped index

```sql
CREATE INDEX IF NOT EXISTS idx_decisions_project ON decisions(project_cwd, tool);
```

### Problem C: `deferred` and `decisions` double-counting

The spec has both tables but doesn't clarify the relationship. Naive implementation would log the same action twice.

### Decision: Deferred = queue view, decisions = permanent log

A deferred action is logged **once** in `decisions` with `decision='defer'`. It is also inserted into `deferred` as the review queue entry. The `deferred` table is a mutable queue; the `decisions` table is the immutable audit log. Stats queries always operate on `decisions` only.

---

## 3. Corrected Fallback Chain (`src/engine/chain.js`)

### Problem A: Static rules came after anomaly detection

A user rule ("always allow `npm run test`") would be ignored if the pattern had never been seen in the current project — anomaly score 1.0 would trigger a deferral before the rule fired. Static rules express explicit user intent and must win over automated inference.

### Problem B: Steps 8–9 (notifications, dashboard) were unreachable

Step 7 (AFK fallback) returned immediately — either auto-approve or `ask`. Steps 8 and 9 were never reachable. Notifications and the dashboard queue need to be integrated as branches within the AFK fallback step.

### Decision: Corrected chain order

```
Step 1 — Sensitive path guard
  Match → always interrupt, regardless of AFK or rules
  AFK ON  → fire-and-forget urgent notification, return ask
  AFK OFF → return ask

Step 2 — Prompt injection
  Match → deny immediately, log reason

Step 3 — Destructive classifier
  Match + AFK ON  → snapshot (git commit), enqueue to deferred, return ask
  Match + AFK OFF → return ask (Claude Code prompts user)

Step 4 — Static rules           [MOVED: was step 5]
  Match found → apply rule decision, return
  No match    → continue

Step 5 — Anomaly detector       [MOVED: was step 4]
  Anomaly + AFK ON  → fire-and-forget notification, enqueue to deferred
  Anomaly + AFK OFF → return ask with anomaly explanation
  Always: upsert baselines table after decision

Step 6 — Behavior predictor
  confidence > 0.85 → auto-decide, return
  confidence < 0.15 → auto-deny, return
  0.15–0.85         → escalate to step 7

Step 7 — Smart AFK fallback     [MERGED: was steps 7 + 8 + 9]
  AFK ON                     → auto-approve, append to digest, return allow
  Notifications configured   → race(phone/telegram response, remaining budget)
    Response received        → apply decision, return
    Timeout                  → race(dashboard queue response, remaining budget)
      Response received      → apply decision, return
      Timeout                → fail closed → return ask
  Neither                    → return ask
```

### Notification side-effects vs blocking

Steps 1, 3, and 5 send notifications as **fire-and-forget** in AFK mode — they do not block the return. Step 7 is the **only** step that awaits a notification response, and only when AFK mode is off and notifications are configured.

---

## Summary of Changes from CLAUDE.md Spec

| Area | Spec | Corrected Design |
|---|---|---|
| Hook timeout | Not enforced | Hard 25s deadline via Promise.race |
| Input storage | Full JSON including content | Sanitized: strip content fields before insert |
| Project index | Missing | `idx_decisions_project ON decisions(project_cwd, tool)` |
| Deferred relationship | Ambiguous | `decision='defer'` in decisions + queue row in deferred |
| Chain step 4 | Anomaly | Static rules |
| Chain step 5 | Static rules | Anomaly |
| Chain steps 8–9 | Unreachable | Merged into step 7 as branches |
