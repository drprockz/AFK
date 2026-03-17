# Phase 6 — Web Dashboard Design Spec

## Goal

Add a local web dashboard to AFK that lets the user review deferred actions, browse decision history, manage rules, and monitor session activity — all from a browser at `http://localhost:6789`.

## Context

Phases 1–5 are complete (127 tests passing). The store layer (`history.js`, `queue.js`, `db.js`), AFK state (`state.js`), digest generator (`digest.js`), and notification system (`notify/`) are all in place. Phase 6 adds the dashboard on top of these without modifying them.

---

## Architecture

### File Structure

```
src/dashboard/
├── server.js       — Express setup, static serving, startup guard
├── api.js          — All REST route handlers
└── ui/
    ├── index.html  — Shell: sidebar nav + <main> content area
    ├── app.js      — Hash router, page render functions, fetch wrappers
    └── style.css   — Dark navy theme, layout, component styles
commands/
├── afk-review.md   — /afk:review command
├── afk-stats.md    — /afk:stats command
├── afk-rules.md    — /afk:rules command
└── afk-reset.md    — /afk:reset command
test/
└── dashboard.test.js — API endpoint tests
```

### Responsibilities

**`server.js`**
- Exports `startServer()` — idempotent (no-op if already running)
- Binds Express to `127.0.0.1:6789`
- Serves `ui/` as static files at `/`
- Mounts `api.js` routes at `/api`
- Called by `afk.md` command on `afk on` and by `afk-review.md`

**`api.js`**
- Imports directly from `src/store/history.js`, `src/store/queue.js`, `src/store/rules.js`, `src/afk/state.js`, `src/afk/digest.js`, `src/notify/notify.js`
- No business logic — data access + response shaping only
- All responses are `application/json`

**`ui/index.html`**
- Static shell with sidebar nav and `<main id="content">` area
- Loads `style.css` and `app.js`
- No inline JS, no CDN dependencies

**`ui/app.js`**
- Sets up `hashchange` listener on `window`
- Maps hash → render function: `#overview` → `renderOverview()`, etc.
- Each render function: fetches from API → injects HTML into `<main>`
- Shared `apiFetch(path)` wrapper for error handling
- Default hash: `#overview`

**`ui/style.css`**
- Dark navy theme: background `#0a0a14`, sidebar `#0d0d1a`, card background `#0d0d1a`, border `#1e1e3a`
- Accent: `#7b8cde` (blue-purple)
- Status colors: allow `#2ecc71`, deny/defer `#e74c3c`, source `#e8a838`
- Sidebar width: `140px`, fixed left
- No CSS framework, no external fonts

---

## Server Lifecycle

- Server starts when `/afk on` is run (via `afk.md` command)
- Server also starts when `/afk:review` is run (if not already running)
- `startServer()` is idempotent — safe to call multiple times
- Binds to `127.0.0.1` only — never exposed on network interfaces

---

## REST API

### `GET /api/status`
Returns current AFK state and session stats.
```json
{
  "afk": false,
  "afk_since": null,
  "afk_until": null,
  "session_id": "abc-123",
  "queue_count": 3,
  "today": {
    "total": 26,
    "auto_approved": 23,
    "auto_denied": 0,
    "deferred": 3,
    "auto_rate": 88
  }
}
```

### `GET /api/decisions`
Paginated decision history.
Query params: `page` (default 1), `limit` (default 50), `tool`, `source`, `date` (ISO date string).
```json
{
  "items": [{ "id": 1, "ts": 1700000000000, "tool": "Bash", "command": "npm run build", "decision": "allow", "source": "prediction", "confidence": 0.92 }],
  "total": 247,
  "page": 1,
  "pages": 5
}
```

### `GET /api/queue`
All unreviewed deferred items.
```json
[{ "id": 1, "ts": 1700000000000, "tool": "Bash", "command": "rm -rf dist/", "path": null, "session_id": "abc-123" }]
```

### `POST /api/queue/:id`
Review a deferred item. Body: `{ "action": "allow" | "deny" }`.
Calls `resolveItem(id, action)` then fires notification if provider configured.
```json
{ "id": 1, "final": "allow", "review_ts": 1700000001000 }
```

### `GET /api/rules`
All rules sorted by priority descending.
```json
[{ "id": "uuid", "tool": "Bash", "pattern": "npm *", "action": "allow", "label": "npm commands", "project": null, "priority": 10 }]
```

### `POST /api/rules`
Create a rule. Body: `{ "tool", "pattern", "action", "label"?, "project"?, "priority"? }`.
Returns created rule with generated `id` (uuid) and `created_ts`.

### `DELETE /api/rules/:id`
Delete a rule by id. Returns `{ "deleted": true }`.

### `GET /api/stats`
Aggregated stats for the Patterns page.
```json
{
  "by_tool": [{ "tool": "Bash", "total": 150, "allow": 130, "deny": 5, "defer": 15 }],
  "top_patterns": [{ "tool": "Bash", "pattern": "npm *", "total": 45, "allow_rate": 0.98 }],
  "by_source": { "user": 10, "rule": 30, "prediction": 180, "auto_afk": 20 }
}
```

### `GET /api/digest`
Current session digest string.
```json
{ "digest": "AFK session digest — 47 minutes AFK\n..." }
```

### `POST /api/afk`
Toggle AFK mode. Body: `{ "on": boolean, "duration"?: number }`.
Calls `setAfk(on, duration)`. Returns new state via `getState()`.

### `GET /api/export`
Download decisions as CSV or JSON.
Query param: `format` (`csv` | `json`, default `json`).
Sets `Content-Disposition: attachment` header.

---

## UI Pages

### `#overview`
- **AFK toggle row**: shows current state (ON/OFF), "Enable AFK" / "Disable AFK" button, calls `POST /api/afk`
- **Stats grid** (3 cards): Auto-approved (green), Deferred (red with link to `#queue`), Auto-rate %
- **Recent decisions list**: last 10 decisions, each row: icon + tool + command/path + time ago

### `#queue`
- **Header**: "Queue — N pending" + "Approve All" button
- **Item cards**: severity badge (CRITICAL/HIGH from classifier), tool, command/path in monospace, project path, Allow/Deny buttons
- On Allow/Deny: `POST /api/queue/:id`, remove item from list with fade, update queue count in sidebar badge
- Empty state: "No pending items" message

### `#history`
- **Filter bar**: tool dropdown, source dropdown, date input, clear button
- **Table**: ts (formatted), tool, command/path (truncated to 40 chars), decision badge, source badge, confidence
- **Pagination**: prev/next buttons, "Page N of M"

### `#patterns`
- **Top patterns table**: tool, pattern, count, approval rate bar (CSS width % of green/red)
- **By-source breakdown**: simple horizontal bar chart using CSS divs (no canvas/SVG)

### `#rules`
- **Rules table**: priority, tool, pattern, action badge, label, scope, created, delete button
- **Add Rule form** (inline, below table, toggled by "Add Rule" button): tool select, pattern input, action toggle (Allow/Deny), label input, scope select (global/current project), priority number input, Save/Cancel

### `#digest`
- `<pre>` block with digest text, monospace, dark background
- "No AFK activity recorded yet." if empty
- Auto-refreshes every 30s if AFK is currently on

---

## Slash Commands

### `commands/afk-review.md`
Calls `startServer()` then opens `http://localhost:6789` in the default browser using `open` (macOS), `xdg-open` (Linux), or `start` (Windows).

### `commands/afk-stats.md`
Terminal-only. Queries DB directly (no server needed). Prints:
- Total requests today
- Auto-approved count and %
- Auto-denied count and %
- Deferred (pending in queue)
- Sensitive alerts
- Current AFK state
- Top 3 auto-approved patterns

### `commands/afk-rules.md`
Terminal CRUD. No server needed.
- `/afk:rules` — list all rules
- `/afk:rules add` — interactive prompts: tool, pattern, action, label
- `/afk:rules remove <id>` — delete by id
- `/afk:rules project` — list rules scoped to cwd

### `commands/afk-reset.md`
Prompts `"Type 'reset' to confirm"`. On confirm: deletes all rows from `decisions`, `sessions`, `deferred`, `baselines`. Preserves `rules` and config file.

---

## Testing

**`test/dashboard.test.js`**
- Start server on a test port (e.g. `process.env.TEST_PORT = 16789`)
- Seed DB with known fixture data
- Hit each API endpoint, assert response shape and values
- Test `POST /api/queue/:id` → assert `resolveItem` called, response contains `final`
- Test `POST /api/afk` → assert state file updated
- Test `GET /api/export?format=csv` → assert CSV headers and row count
- Teardown: close server, clear test DB

**No browser automation** — API tests only.

---

## Constraints

- No CDN dependencies in `index.html` — must work fully offline
- No React, no bundler, no TypeScript
- `style.css` uses only CSS variables and standard properties (no PostCSS)
- `server.js` must not import from `src/engine/` — dashboard is read/write only, never re-runs the decision chain
- All DB access goes through existing store modules — no raw SQL in `api.js`
- `startServer()` must be synchronous-safe to call from a slash command (which may not be async)
