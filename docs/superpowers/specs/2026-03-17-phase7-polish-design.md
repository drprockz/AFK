# Phase 7 — Polish & Publish Design Spec

**Date**: 2026-03-17
**Scope**: session.js + marketplace.json + README.md
**Deferred**: Trust profiles, weekly digest emails, marketplace submission (manual)

---

## 1. `src/store/session.js`

### Purpose

Wire the existing `sessions` table (defined in db.js but currently unused) with a dedicated module that tracks session lifecycle, request counts, and token estimation. Sessions are keyed on the `session_id` from `~/.claude/afk/state.json` (one session per AFK state lifecycle).

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
  - `source='rule'` or `source='prediction'`, `decision='allow'` → `auto_allow++`
  - `source='rule'` or `source='prediction'`, `decision='deny'` → `auto_deny++`
  - `source='user'`, `decision='allow'` → `user_allow++`
  - `source='user'`, `decision='deny'` → `user_deny++`
  - `decision='defer'` → `deferred++`
  - `source='auto_afk'` → `auto_allow++`
  - `source='chain'`, `decision='deny'` → `auto_deny++`
  - `source='chain'`, `decision='allow'` → `auto_allow++`
  - Any unmatched combination: increment `total_req` only (no counter category)

```js
addTokenEstimate(sessionId, tokens)
```
- `UPDATE sessions SET tokens_est = tokens_est + ? WHERE id = ?`

```js
estimateTokens(tool, input)
```
- Heuristic per tool type:
  - `Bash` → `Math.ceil(len(command) / 4) + 50`
  - `Write` → `Math.ceil(len(content) / 4) + 50`
  - `Edit` → `Math.ceil((len(old_string) + len(new_string)) / 4) + 50`
  - `Read`, `Glob`, `Grep`, `LS`, `Search` → flat `100`
  - Unknown tool → flat `100`
- Returns integer

```js
endSession(sessionId)
```
- `UPDATE sessions SET ended_ts = Date.now() WHERE id = ?`

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
getActiveSession()
```
- `SELECT * FROM sessions WHERE ended_ts IS NULL ORDER BY started_ts DESC LIMIT 1`
- Returns row object or `null`

### Integration Points

**`src/hook.js`** — After `chain()` returns and `updateBaseline()` is called, add:
```js
import { ensureSession, updateSessionStats, addTokenEstimate, estimateTokens } from './store/session.js'

// post-chain (inside the try block, after updateBaseline)
const sessionId = request.session_id
ensureSession(sessionId, request.cwd)
updateSessionStats(sessionId, result.decision, result.source)
addTokenEstimate(sessionId, estimateTokens(request.tool, request.input))
```

**`src/dashboard/api.js`** — Add two new endpoints:
- `GET /api/sessions` — calls `listSessions({ page, limit })`, query params: `page`, `limit`
- `GET /api/sessions/:id` — calls `getSession(id)`, returns 404 if null

**`scripts/afk-cli.js`** — On `/afk off`, call `endSession(getSessionId())` to close the current session.

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
5. **How it works** — Text-art diagram of the 7-step decision chain:
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
   [7. AFK fallback] ──AFK on──▶ auto-approve + log
                      ──AFK off──▶ ask user normally
   ```
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
- `updateSessionStats` increments `deferred` for defer decision
- `updateSessionStats` increments `auto_allow` for auto_afk source
- `estimateTokens` returns reasonable values for each tool type
- `endSession` sets ended_ts
- `getSession` returns null for nonexistent ID
- `listSessions` returns paginated results in descending order
- `getActiveSession` returns session with null ended_ts

Uses in-memory SQLite (via `AFK_DB_DIR` env var pointing to temp dir) for test isolation.

---

## 5. Files Changed Summary

| File | Action | Description |
|------|--------|-------------|
| `src/store/session.js` | **Create** | Session tracking module |
| `marketplace/marketplace.json` | **Create** | Marketplace catalog |
| `README.md` | **Create** | Full project README |
| `test/session.test.js` | **Create** | Session module tests |
| `src/hook.js` | **Modify** | Add session tracking calls post-chain |
| `src/dashboard/api.js` | **Modify** | Add /api/sessions endpoints |
| `scripts/afk-cli.js` | **Modify** | Call endSession on /afk off |

### Files NOT changed
- `src/store/db.js` — schema already has sessions table
- `src/engine/chain.js` — no changes needed
- `.claude-plugin/plugin.json` — no changes needed
