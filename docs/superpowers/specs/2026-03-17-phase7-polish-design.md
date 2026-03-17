# Phase 7 — Polish & Publish Design Spec

**Date**: 2026-03-17
**Scope**: session.js + marketplace.json + README.md

### Phase 7 scope accounting

| CLAUDE.md Phase 7 item | Status |
|------------------------|--------|
| Session tracking + token estimation | **This spec** |
| Marketplace catalog | **This spec** |
| README | **This spec** |
| Audit export (CSV/JSON) | Already done (`GET /api/export` in Phase 6) |
| Trust profiles per project/branch | Deferred — complex feature, out of Phase 7 |
| Weekly digest emails | Deferred — requires cron/daemon, out of Phase 7 |
| Marketplace submission | Manual process, out of scope for code |

---

## 1. `src/store/session.js`

### Purpose

Wire the existing `sessions` table (defined in db.js but currently unused) with a dedicated module that tracks session lifecycle, request counts, and token estimation. Sessions are keyed on the `session_id` from `~/.claude/afk/state.json`.

### Session lifecycle

Sessions are long-lived accumulation buckets. There is no explicit end boundary — the `ended_ts` column remains available for future use but is **not set** in Phase 7. This avoids lifecycle bugs: since `state.json` keeps the same `session_id` across AFK on/off cycles, calling `endSession` on `/afk off` would permanently close a row that `ensureSession` (INSERT OR IGNORE) can never reopen. By not setting `ended_ts`, all hook invocations correctly accumulate stats on the current session regardless of AFK state.

### Exported Functions

```js
ensureSession(sessionId, projectCwd)
```
- `INSERT OR IGNORE` a new row with `started_ts = Date.now()`, `project_cwd = projectCwd`
- Returns `{ created: boolean }`
- Idempotent — safe to call on every hook invocation

```js
updateSessionStats(sessionId, decision, source)
```
- Increments `total_req` by 1
- Increments the appropriate counter based on source/decision mapping:
  - `source='rule'`, `decision='allow'` → `auto_allow++`
  - `source='rule'`, `decision='deny'` → `auto_deny++`
  - `source='prediction'`, `decision='allow'` → `auto_allow++`
  - `source='prediction'`, `decision='deny'` → `auto_deny++`
  - `source='chain'`, `decision='deny'` → `auto_deny++`
  - `source='chain'`, `decision='ask'` → no counter (total_req only)
  - `source='auto_afk'` (any decision) → `auto_allow++`
  - `source='auto_defer'`, `decision='defer'` → `deferred++`
  - `source='notification'`, `decision='deny'` → `auto_deny++` (only notification-sourced outcome; allow outcomes are logged as `auto_afk`)
  - `source='user'`, `decision='allow'` → `user_allow++`
  - `source='user'`, `decision='deny'` → `user_deny++`
  - `source='prediction'`, `decision='ask'` → no counter (total_req only — mid-band AFK-off escalation)
  - Any other unmatched combination: increment `total_req` only (no counter category)

Note: `source='chain'` with `decision='allow'` never occurs in practice — no chain code path produces it. The deadline-expired path in `hook.js` (Promise.race timeout) may produce `undefined` decision/source; the hook.js integration must default these to `'ask'` and `'chain'` respectively (see integration snippet below).

```js
addTokenEstimate(sessionId, tokens)
```
- `UPDATE sessions SET tokens_est = tokens_est + ? WHERE id = ?`

```js
estimateTokens(tool, input)
```
- Heuristic per tool type (all field access must be null-safe with `?.length ?? 0`):
  - `Bash` → `Math.ceil((input.command?.length ?? 0) / 4) + 50`
  - `Write` → `Math.ceil((input.content?.length ?? 0) / 4) + 50`
  - `Edit` → `Math.ceil(((input.old_string?.length ?? 0) + (input.new_string?.length ?? 0)) / 4) + 50`
  - `Read`, `Glob`, `Grep`, `LS`, `Search` → flat `100`
  - Unknown tool → flat `100`
- Returns integer (never NaN)

```js
getSession(sessionId)
```
- `SELECT * FROM sessions WHERE id = ?`
- Returns row object or `null`

```js
listSessions({ page = 1, limit = 20 })
```
- `SELECT * FROM sessions ORDER BY started_ts DESC LIMIT ? OFFSET ?`
- Returns `{ sessions: [...], total: number, page, limit }`

```js
getMostRecentSession()
```
- `SELECT * FROM sessions ORDER BY started_ts DESC LIMIT 1`
- Returns row object or `null`
- Note: Since `ended_ts` is never set in Phase 7, a query filtering on `ended_ts IS NULL` would return all sessions. This function simply returns the most recently started session without implying an active/ended lifecycle.

### Integration Points

**`src/engine/chain.js`** — Modify every `return` statement to include `decision` and `source` fields alongside existing `behavior` and `reason`. This is necessary because `behavior` maps to Claude Code's protocol (`allow`/`deny`/`ask`) while `decision` reflects the internal decision (`allow`/`deny`/`defer`/`ask`) and `source` identifies the decision maker. Mapping of every return path:

| Chain step | behavior | decision | source |
|------------|----------|----------|--------|
| Deadline expired | `ask` | `ask` | `chain` |
| Step 1: Sensitive path | `ask` | `ask` | `chain` |
| Step 2: Injection | `deny` | `deny` | `chain` |
| Step 3: Destructive + deny rule | `deny` | `deny` | `rule` |
| Step 3: Destructive + AFK on | `ask` | `defer` | `auto_defer` |
| Step 3: Destructive + AFK off | `ask` | `ask` | `chain` |
| Step 4: Static rule match | allow/deny | allow/deny | `rule` |
| Step 5: Anomaly + AFK on | `ask` | `defer` | `auto_defer` |
| Step 5: Anomaly + AFK off | `ask` | `ask` | `chain` |
| Step 6: High confidence | allow/deny | allow/deny | `prediction` |
| Step 6: Low confidence auto-deny | `deny` | `deny` | `prediction` |
| Step 7: Notification deny | `deny` | `deny` | `notification` |
| Step 7: AFK auto-approve | `allow` | `allow` | `auto_afk` |
| Step 6: Mid-band AFK off (ask user) | `ask` | `ask` | `prediction` |

**`src/hook.js`** — After `chain()` returns and `updateBaseline()` is called, add session tracking. **Prerequisite**: `chain.js` must be updated first to return `decision` and `source` fields. The snippet includes fallback defaults for safety:
```js
import { ensureSession, updateSessionStats, addTokenEstimate, estimateTokens } from './store/session.js'

// post-chain (inside the try block, after updateBaseline)
const sessionId = request.session_id
ensureSession(sessionId, request.cwd)
updateSessionStats(sessionId, result.decision ?? result.behavior ?? 'ask', result.source ?? 'chain')
addTokenEstimate(sessionId, estimateTokens(request.tool, request.input))
```

**`src/dashboard/api.js`** — Add two new endpoints (API-only, not consumed by dashboard UI in Phase 7; available for external tooling and future UI pages):
- `GET /api/sessions` — calls `listSessions({ page, limit })`, query params: `page`, `limit`
- `GET /api/sessions/:id` — calls `getSession(id)`, returns 404 if null

**`scripts/afk-cli.js`** — No session changes needed. Sessions are not explicitly ended.

### Database

No schema changes needed — the `sessions` table already exists in `db.js` with all required columns.

---

## 2. `marketplace/marketplace.json`

### Purpose

Catalog file for the `drprockz/afk-marketplace` repository. Required for marketplace submission.

### Content

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

No integration points — standalone file.

---

## 3. `README.md`

### Purpose

Full project README per CLAUDE.md spec requirements.

### Structure

1. **Philosophy** — Verbatim opening from CLAUDE.md: "Claude Code interrupts you. Every permission prompt is a context switch..." through "Every feature in this project flows from that sentence."
2. **One-sentence description** — What AFK is in one line.
3. **Install** — Two commands: marketplace add + plugin install.
4. **Features** — Bullet list of capabilities (decision chain, AFK mode, destructive deferral, anomaly detection, notifications, dashboard, slash commands, session tracking).
5. **How it works** — Text-art diagram of the decision chain matching `chain.js` implementation order, including notification step:
   ```
   PermissionRequest
        │
        ▼
   [1. Sensitive path?] ──yes──▶ Always interrupt user
        │ no
        ▼
   [2. Injection detected?] ──yes──▶ Deny immediately
        │ no
        ▼
   [3. Destructive?] ──yes──▶ AFK: snapshot + defer │ Present: interrupt
        │ no
        ▼
   [4. Static rule match?] ──yes──▶ Apply rule (allow/deny)
        │ no
        ▼
   [5. Anomaly?] ──yes──▶ AFK: defer │ Present: interrupt
        │ no
        ▼
   [6. Behavior prediction]
        │ confidence > 0.85 → auto-decide
        │ confidence < 0.15 → auto-deny
        │ otherwise → escalate
        ▼
   [7. AFK fallback + notifications]
        │ AFK on → notify phone → auto-approve
        │ AFK off → ask user normally
   ```
   Note: Step numbering follows `chain.js` implementation (rules before anomaly), which differs from CLAUDE.md's original spec numbering. The README documents the actual system behavior.
6. **AFK mode** — What happens when on, digest on return, deferred queue.
7. **Configuration** — Key fields from `~/.claude/afk/config.json` with brief explanations.
8. **Commands** — Table: `/afk`, `/afk:review`, `/afk:stats`, `/afk:rules`, `/afk:reset`.
9. **Contributing** — Fork, install deps, run tests (`node --test test/*.test.js`), open PR.
10. **License** — MIT.

No screenshots. Text diagrams only. Approximately 200-300 lines.

---

## 4. Tests

### `test/session.test.js`

Test cases:
- `ensureSession` creates a row with correct started_ts and project_cwd
- `ensureSession` is idempotent (second call returns `{ created: false }`)
- `updateSessionStats` increments `total_req` for every call
- `updateSessionStats` increments `auto_allow` for prediction+allow
- `updateSessionStats` increments `auto_deny` for prediction+deny
- `updateSessionStats` increments `user_allow` for user+allow
- `updateSessionStats` increments `user_deny` for user+deny
- `updateSessionStats` increments `deferred` for auto_defer+defer
- `updateSessionStats` increments `auto_allow` for auto_afk source
- `updateSessionStats` increments `auto_deny` for notification+deny
- `updateSessionStats` increments `auto_allow` for notification+allow
- `estimateTokens` returns reasonable values for each tool type
- `estimateTokens` handles undefined/null input fields without NaN
- `getSession` returns null for nonexistent ID
- `listSessions` returns paginated results in descending order
- `getMostRecentSession` returns the session with the latest started_ts

Uses temp directory (via `AFK_DB_DIR` env var) for database isolation. Tests pass synthetic session IDs directly to functions — no dependency on `state.js` or `AFK_STATE_DIR`.

---

## 5. Files Changed Summary

| File | Action | Description |
|------|--------|-------------|
| `src/store/session.js` | **Create** | Session tracking module |
| `marketplace/marketplace.json` | **Create** | Marketplace catalog |
| `README.md` | **Create** | Full project README |
| `test/session.test.js` | **Create** | Session module tests |
| `src/engine/chain.js` | **Modify** | Add `decision` + `source` fields to every return value |
| `src/hook.js` | **Modify** | Add session tracking calls post-chain |
| `src/dashboard/api.js` | **Modify** | Add /api/sessions endpoints |

### Files NOT changed
- `src/store/db.js` — schema already has sessions table
- `scripts/afk-cli.js` — no session lifecycle changes needed
- `.claude-plugin/plugin.json` — no changes needed
