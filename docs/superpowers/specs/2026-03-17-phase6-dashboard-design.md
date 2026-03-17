# Phase 6 — Web Dashboard Design Spec

## Goal

Add a local web dashboard to AFK that lets the user review deferred actions, browse decision history, manage rules, and monitor session activity — all from a browser at `http://localhost:6789`.

## Context

Phases 1–5 are complete (127 tests passing). The store layer (`history.js`, `queue.js`, `db.js`), AFK state (`state.js`), digest generator (`digest.js`), notification system (`notify/`), and rules engine (`engine/rules.js`) are all in place. Phase 6 adds the dashboard on top of these with minimal additions to the store layer (new query functions in `history.js`).

Slash commands follow the pattern established in `commands/afk.md`: each `.md` file resolves the script path using `$PLUGIN_DIR` with a fallback to `git rev-parse --show-toplevel`, then runs it with `node`. All scripts live in `scripts/`.

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
scripts/
├── afk-review-cli.js   — Script for /afk:review
├── afk-stats-cli.js    — Script for /afk:stats
├── afk-rules-cli.js    — Script for /afk:rules
└── afk-reset-cli.js    — Script for /afk:reset
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
- Exports `startServer(port = 6789)` — idempotent (no-op if already running), accepts optional port for test isolation
- Uses a module-level `_server` variable to track running state; within the same process, second call returns immediately
- If two separate processes both call `startServer(6789)`, the second will get EADDRINUSE — catch it, log to stderr, and return silently (acceptable for v1)
- Binds Express to `127.0.0.1:<port>`
- Serves `ui/` as static files at `/`
- Mounts `api.js` routes at `/api`
- No graceful shutdown needed for v1 — server exits with the Claude Code session

**`api.js`**
- Imports from: `src/store/history.js`, `src/store/queue.js`, `src/engine/rules.js`, `src/afk/state.js`, `src/afk/digest.js`, `src/notify/notify.js`, `src/notify/config.js`
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
- Shared `apiFetch(path, opts?)` wrapper for error handling (catches network errors, renders error message in `<main>`)
- Default hash: `#overview`
- Module-level `_refreshInterval` variable — each render function clears it at the top (`clearInterval(_refreshInterval)`) before setting a new one if needed. This ensures only one auto-refresh ever runs at a time.

**`ui/style.css`**
- Dark navy theme: background `#0a0a14`, sidebar `#0d0d1a`, card background `#0d0d1a`, border `#1e1e3a`
- Accent: `#7b8cde` (blue-purple)
- Status colors: allow `#2ecc71`, deny/defer `#e74c3c`, source `#e8a838`
- Sidebar width: `140px`, fixed left
- No CSS framework, no external fonts

---

## Store Layer Additions

Phase 6 requires three new exported functions added to `src/store/history.js`. No other existing files are modified.

### `listDecisions({ page, limit, tool, source, decision, date })`
Paginated query of the decisions table.
- `page`: integer, default 1
- `limit`: integer, default 50, max 200
- `tool`: optional string filter (exact match)
- `source`: optional string filter (exact match)
- `decision`: optional string filter (exact match — `allow`, `deny`, `defer`, `ask`)
- `date`: optional ISO date string — filters to decisions where `ts` falls within that calendar day (UTC)
- Returns `{ items: [...], total: number, page: number, pages: number }`
- Each item: `{ id, ts, tool, command, path, decision, source, confidence, reason }`

### `getDecisionStats()`
Aggregated stats over the last 90 days.
- Returns `{ by_tool, top_patterns, by_source }` matching the `/api/stats` response shape below
- `by_tool`: `SELECT tool, COUNT(*) as total, SUM(decision='allow') as allow, SUM(decision='deny') as deny, SUM(decision='defer') as defer FROM decisions WHERE ts >= ? GROUP BY tool ORDER BY total DESC`
- `top_patterns`: `SELECT tool, COALESCE(command, path, tool) as pattern, COUNT(*) as total, ROUND(AVG(decision='allow'), 2) as allow_rate FROM decisions WHERE ts >= ? GROUP BY tool, pattern ORDER BY total DESC LIMIT 20`
- `by_source`: `SELECT source, COUNT(*) as count FROM decisions WHERE ts >= ? GROUP BY source` — returned as a flat object `{ user: N, rule: N, prediction: N, auto_afk: N }`
- Uses raw SQL via `getDb()` directly within `history.js`

### `getTodayStats()`
Decision counts for the current calendar day (UTC).
- Returns `{ total, auto_approved, auto_denied, deferred }` as integers
- Day boundary: `ts >= startOfTodayUTC` where `startOfTodayUTC = new Date().setUTCHours(0,0,0,0)`
- `auto_approved`: count where `decision = 'allow'` and `source != 'user'`
- `auto_denied`: count where `decision = 'deny'` and `source != 'user'`
- `deferred`: count where `decision = 'defer'`

---

## Server Lifecycle

- Server starts when `/afk on` is run: `scripts/afk-cli.js` must call `startServer()` when the `on` subcommand is processed (in addition to the existing AFK state toggle)
- Server also starts when `/afk:review` is run
- `startServer(port?)` is idempotent within a process via `_server` variable; EADDRINUSE from a second process is silently caught
- Binds to `127.0.0.1` only — never exposed on network interfaces
- Tests inject a different port via `startServer(16789)` to avoid conflicts

---

## REST API

### `GET /api/status`
Returns current AFK state and today's session stats.
Uses `getState()` from `state.js` and `getTodayStats()` + `getPendingCount()` from store.
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
`auto_rate` is `Math.round(auto_approved / total * 100)`, or 0 if total is 0.

### `GET /api/decisions`
Paginated decision history. Calls `listDecisions({ page, limit, tool, source, date })`.
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
All unreviewed deferred items. Calls `getPendingItems()`.
```json
[{ "id": 1, "ts": 1700000000000, "tool": "Bash", "command": "rm -rf dist/", "path": null, "session_id": "abc-123" }]
```

### `POST /api/queue/:id`
Review a deferred item. Body: `{ "action": "allow" | "deny" }`.
1. Returns 400 `{ "error": "invalid action" }` if action is not `allow` or `deny`.
2. Fetches the deferred row from DB before resolving (needed for tool/command/path in notification).
3. Calls `resolveItem(id, action)` from `queue.js`. `resolveItem` returns `true` if a row was updated, `false` if id not found. Both cases return 200 — the endpoint is idempotent.
4. If a notification provider is configured: calls `loadConfig()` from `notify/config.js`, then fires `notify(config, { tool, command, path, requestId: String(id) }, Date.now() + 5000)` using data from the fetched row. The `requestId` is the deferred item id cast to string. This is fire-and-forget — do NOT await it; use `.catch(err => process.stderr.write(...))`. The HTTP response is sent immediately without waiting for notify to settle.
5. Response is constructed manually from the input data (not re-read from DB): `{ "id": Number(id), "final": action, "review_ts": Date.now() }`. Returns this whether or not `resolveItem` found a row.

### `GET /api/rules`
All rules sorted by priority descending. Calls `listRules(null)` (global + all projects).
```json
[{ "id": "uuid", "tool": "Bash", "pattern": "npm *", "action": "allow", "label": "npm commands", "project": null, "priority": 10 }]
```

### `POST /api/rules`
Create a rule. Body: `{ "tool", "pattern", "action", "label"?, "project"?, "priority"? }`.
Required fields: `tool`, `pattern`, `action`. Missing required fields return 400 `{ "error": "missing field: <name>" }`.
Calls `addRule(...)` from `engine/rules.js`. Returns created rule with generated `id` (uuid) and `created_ts`.

### `DELETE /api/rules/:id`
Delete a rule by id. Calls `removeRule(id)`. Always returns 200 `{ "deleted": true }` — idempotent (deleting a non-existent id is a no-op, not an error). `removeRule` does not return a value, so 404 is not detectable and not needed here.

### `GET /api/stats`
Aggregated stats for the Patterns page. Calls `getDecisionStats()`.
```json
{
  "by_tool": [{ "tool": "Bash", "total": 150, "allow": 130, "deny": 5, "defer": 15 }],
  "top_patterns": [{ "tool": "Bash", "pattern": "npm run build", "total": 45, "allow_rate": 0.98 }],
  "by_source": { "user": 10, "rule": 30, "prediction": 180, "auto_afk": 20 }
}
```

### `GET /api/digest`
Current session digest string.
Assembles by calling `getState().digest` to get entries array, `getPendingCount()` for pending count, then passes both to `buildDigest(entries, pendingCount)` from `digest.js`. Uses read-only `getState()` — does NOT call `getAndClearDigest()`.
When there is no activity, `buildDigest` returns the sentinel string `"No activity during AFK session."` — not an empty string. The API always returns this string verbatim; it never returns `""`.
```json
{ "digest": "AFK session digest — 47 minutes AFK\n..." }
```

### `POST /api/afk`
Toggle AFK mode. Body: `{ "on": boolean, "duration"?: number }`.
Calls `setAfk(on, duration)`. Returns new state via `getState()`.

### `GET /api/export`
Download decisions as CSV or JSON.
Query param: `format` (`csv` | `json`, default `json`).
Sets `Content-Disposition: attachment; filename="afk-decisions.<ext>"` header.
For CSV: header row is `id,ts,tool,command,path,decision,source,confidence`; fetches up to 10,000 rows (hard cap, silently truncated — acceptable for v1, no truncation header needed).

---

## UI Pages

### `#overview`
- **AFK toggle row**: shows current state (ON/OFF), "Enable AFK" / "Disable AFK" button, calls `POST /api/afk`
- **Stats grid** (3 cards): Auto-approved (green), Deferred (red with link to `#queue`), Auto-rate %
- **Recent decisions list**: last 10 decisions from `GET /api/decisions?limit=10`, each row: icon + tool + command/path + time ago

### `#queue`
- **Header**: "Queue — N pending" + "Approve All" button
- **Item cards**: severity badge (CRITICAL/HIGH from classifier), tool, command/path in monospace, project path, Allow/Deny buttons
- On Allow/Deny: `POST /api/queue/:id`, remove item from list with CSS fade-out, decrement queue count in sidebar badge
- **Approve All**: disables all buttons during execution, iterates each pending item sequentially calling `POST /api/queue/:id` with `action: "allow"`. On any error, shows an inline error message and stops. No batch endpoint.
- Empty state: "No pending items" message

### `#history`
- **Filter bar**: tool dropdown, source dropdown, date input, clear button
- **Table**: ts (formatted as `YYYY-MM-DD HH:mm`), tool, command/path (truncated to 40 chars), decision badge, source badge, confidence (shown as `92%` or `—` if null)
- **Pagination**: prev/next buttons, "Page N of M"

### `#patterns`
- **Top patterns table**: tool, pattern, count, approval rate bar (CSS width % of green/red)
- **By-source breakdown**: simple horizontal bar chart using CSS divs (no canvas/SVG)

### `#rules`
- **Rules table**: priority, tool, pattern, action badge, label, scope, created, delete button
- **Add Rule form** (inline, below table, toggled by "Add Rule" button): tool select, pattern input, action toggle (Allow/Deny), label input, scope select (global/current project), priority number input, Save/Cancel

### `#digest`
- `<pre>` block with digest text, monospace, dark background
- The `GET /api/digest` response always contains a non-empty string (sentinel or real digest). The UI renders it as-is — no special empty-string check needed.
- Auto-refresh: on render, call `GET /api/status`; if `afk: true`, set `_refreshInterval = setInterval(fetchAndRenderDigest, 30000)`. Since every render function calls `clearInterval(_refreshInterval)` first, only one interval ever runs.

---

## Slash Commands

All commands use the same path-resolution pattern as `afk.md`:
```bash
SCRIPT="${PLUGIN_DIR}/scripts/<name>-cli.js"
if [ -z "$PLUGIN_DIR" ] || [ ! -f "$SCRIPT" ]; then
  SCRIPT="$(git rev-parse --show-toplevel 2>/dev/null)/scripts/<name>-cli.js"
fi
node "$SCRIPT" <args>
```

### `commands/afk-review.md` → `scripts/afk-review-cli.js`
Imports `startServer` from `../src/dashboard/server.js`, calls `startServer()`, then uses `child_process.execSync` to open `http://localhost:6789` (`open` macOS, `xdg-open` Linux, `start` Windows — detect via `process.platform`).

### `commands/afk-stats.md` → `scripts/afk-stats-cli.js`
Imports `getTodayStats`, `getPendingCount` from `../src/store/history.js`, `isAfk` from `../src/afk/state.js`, `listDecisions` from `../src/store/history.js`. Prints formatted terminal summary:
```
AFK Stats — today
  Total requests:    26
  Auto-approved:     23 (88%)
  Auto-denied:       0 (0%)
  User-reviewed:     3
  Deferred (queue):  3 pending
  AFK mode:          OFF

Top auto-approved patterns:
  1. Bash: npm run *
  2. Read: src/*
  3. Bash: git status
```
Top patterns: calls `getDecisionStats().top_patterns` and takes the first 3 items.

### `commands/afk-rules.md` → `scripts/afk-rules-cli.js`
Imports `listRules`, `addRule`, `removeRule` from `../src/engine/rules.js`. Handles subcommands via `process.argv`:
- No args: prints all rules as a formatted table
- `add tool=<t> pattern=<p> action=<a> [label=<l>]`: parses key=value args, calls `addRule(...)`, prints created rule
- `remove <id>`: calls `removeRule(id)`, prints "Deleted rule <id>"
- `project`: calls `listRules(process.cwd())`, prints project-scoped rules

### `commands/afk-reset.md` → `scripts/afk-reset-cli.js`
Prints "Type 'reset' to confirm:" and reads a line from stdin (`readline` module). If confirmed: opens the DB via `getDb()`, runs `DELETE FROM decisions`, `DELETE FROM sessions`, `DELETE FROM deferred`, `DELETE FROM baselines`. Prints counts of deleted rows. Preserves `rules` table and config file.

---

## Testing

**`test/dashboard.test.js`**
- Set env vars before any imports: `AFK_DB_DIR`, `AFK_STATE_DIR`, `AFK_CONFIG_DIR` all pointing to the same temp dir to isolate from real data
- Start server on port 16789 via `startServer(16789)` before tests
- Seed DB with fixture data (known decisions, deferred items, rules)
- Hit each API endpoint, assert response shape and values:
  - `GET /api/status` → assert `afk`, `queue_count`, `today` fields present
  - `GET /api/decisions` → assert `items` array, `total`, `page`, `pages`
  - `GET /api/decisions?tool=Bash` → assert all items have `tool: "Bash"`
  - `GET /api/queue` → assert array of deferred items
  - `POST /api/queue/:id` with `{ action: "allow" }` → assert `final: "allow"` in response
  - `POST /api/queue/:id` with invalid action → assert 400
  - `GET /api/rules` → assert array
  - `POST /api/rules` with valid body → assert created rule returned with `id`
  - `POST /api/rules` missing `tool` → assert 400 `{ error: "missing field: tool" }`
  - `DELETE /api/rules/:id` → assert `{ deleted: true }`
  - `GET /api/stats` → assert `by_tool`, `top_patterns`, `by_source` present
  - `GET /api/digest` → assert `digest` string field
  - `POST /api/afk` → assert state reflects new value
  - `GET /api/export?format=csv` → assert `Content-Disposition` header, CSV row format
- Teardown: close server, delete temp dir

**No browser automation** — API tests only.

---

## Constraints

- No CDN dependencies in `index.html` — must work fully offline
- No React, no bundler, no TypeScript
- `style.css` uses only CSS variables and standard properties (no PostCSS)
- `server.js` must not import from `src/engine/` (exception: `api.js` imports `src/engine/rules.js` for rule CRUD — acceptable since rules is data management, not decision logic)
- All DB access goes through store modules or new functions added to `history.js` — no raw SQL scattered across `api.js`
- `startServer()` is async internally (Express `listen` is async) but the call is fire-and-forget from the command scripts — they do not need to await it
