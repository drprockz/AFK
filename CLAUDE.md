# CLAUDE.md — AFK

## Philosophy

Claude Code interrupts you. Every permission prompt is a context switch that breaks flow. When you step away, Claude stalls entirely. When it does proceed, you have no record of what it decided or why.

AFK is the intelligent permission layer that fixes this. It learns how you work, decides confidently on your behalf, defers what's dangerous, and never lets Claude stall because you're not watching.

**Core principle: Claude should never interrupt you when you're away, and should never do something irreversible without your knowledge.**

Every feature in this project flows from that sentence.

---

## Project identity

- **Name**: AFK
- **Package**: `@drprockz/afk`
- **Marketplace**: `drprockz/afk-marketplace`
- **License**: MIT
- **Publisher**: drprockz
- **Target**: Claude Code plugin marketplace (official Anthropic marketplace submission once stable)
- **Cross-platform goal**: Claude Code first, then Codex and OpenCode

---

## What this is technically

A Claude Code plugin that registers a `PermissionRequest` hook. Every time Claude Code would show a permission prompt, it calls AFK first. AFK runs the request through a decision chain and returns `{"behavior": "allow"}`, `{"behavior": "deny"}`, or `{"behavior": "ask"}`. Users install it with:

```
/plugin marketplace add drprockz/afk-marketplace
/plugin install afk@drprockz
```

---

## Repository structure

```
afk/
├── .claude-plugin/
│   └── plugin.json                  # Plugin metadata, hook + command registration
├── .claude/
│   └── settings.json                # Local dev hook wiring for testing
├── commands/
│   ├── afk.md                       # /afk command (on | off | status | <duration>)
│   ├── afk-review.md                # /afk:review — opens web dashboard
│   ├── afk-stats.md                 # /afk:stats — terminal summary
│   ├── afk-rules.md                 # /afk:rules — list/add/remove rules
│   └── afk-reset.md                 # /afk:reset — wipe history
├── src/
│   ├── hook.js                      # Entry point — called by Claude Code on every PermissionRequest
│   ├── engine/
│   │   ├── chain.js                 # Fallback chain orchestrator (main decision loop)
│   │   ├── classifier.js            # Destructive action detection
│   │   ├── sensitive.js             # Sensitive path / secret file guard
│   │   ├── anomaly.js               # Statistical anomaly detection vs session baseline
│   │   ├── injection.js             # Prompt injection detection in file content
│   │   ├── rules.js                 # Static rule matching (always-allow / always-deny)
│   │   └── predictor.js             # Behavior prediction — confidence scoring from history
│   ├── store/
│   │   ├── db.js                    # SQLite setup, schema migrations, WAL mode
│   │   ├── history.js               # Decision logging and pattern queries
│   │   ├── queue.js                 # Deferral queue CRUD
│   │   └── session.js               # Session tracking (baseline activity, cost, tokens)
│   ├── safety/
│   │   └── snapshot.js              # Auto-commit safety net before destructive actions
│   ├── notify/
│   │   ├── ntfy.js                  # ntfy.sh push notification sender
│   │   └── telegram.js              # Telegram bot notification sender
│   ├── afk/
│   │   ├── state.js                 # AFK state read/write (~/.claude/afk/state.json)
│   │   ├── detector.js              # Inactivity detector (auto AFK after N minutes idle)
│   │   └── digest.js                # Session digest generator (narrative of what happened)
│   └── dashboard/
│       ├── server.js                # Express server (localhost only)
│       ├── api.js                   # REST endpoints
│       └── ui/
│           ├── index.html
│           ├── app.js
│           └── style.css
├── test/
│   ├── classifier.test.js
│   ├── predictor.test.js
│   ├── chain.test.js
│   └── fixtures/                    # Sample PermissionRequest JSON payloads
├── scripts/
│   └── setup.js                     # Post-install setup (creates ~/.claude/afk/ dir, db)
├── README.md
├── CLAUDE.md                        # This file
├── package.json
└── marketplace/
    └── marketplace.json             # Marketplace catalog for drprockz/afk-marketplace
```

---

## Tech stack

- **Runtime**: Node.js 18+ (matches Claude Code's requirement, no extra runtime)
- **Database**: `better-sqlite3` — synchronous SQLite, WAL mode, fast reads
- **Web server**: `express` — local dashboard only, localhost-bound
- **Testing**: `node:test` + `node:assert` — zero extra deps for tests
- **Notifications**: native `fetch` — no extra HTTP libs
- **No build step** — plain ESM, runs directly

### Allowed dependencies
```json
{
  "better-sqlite3": "latest",
  "express": "latest"
}
```

Everything else uses Node.js built-ins. No TypeScript, no bundler, no transpilation. Keep it simple and fast.

---

## Plugin manifest

### `.claude-plugin/plugin.json`
```json
{
  "name": "afk",
  "version": "0.1.0",
  "description": "Intelligent permission layer for Claude Code. Learns your patterns, handles AFK mode, defers destructive actions, never lets Claude stall.",
  "author": "drprockz",
  "license": "MIT",
  "homepage": "https://github.com/drprockz/afk",
  "hooks": {
    "PermissionRequest": {
      "command": "node",
      "args": ["${pluginDir}/src/hook.js"]
    }
  },
  "commands": [
    { "name": "afk", "description": "Toggle AFK mode on/off or set a duration" },
    { "name": "afk:review", "description": "Open AFK web dashboard in browser" },
    { "name": "afk:stats", "description": "Show today's decision summary in terminal" },
    { "name": "afk:rules", "description": "List, add, or remove static rules" },
    { "name": "afk:reset", "description": "Clear decision history and start fresh" }
  ]
}
```

---

## Database schema

File location: `~/.claude/afk/afk.db`

```sql
-- Every decision ever made, by anyone (user, auto, rule, deferred)
CREATE TABLE IF NOT EXISTS decisions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,               -- unix ms
  session_id  TEXT NOT NULL,
  tool        TEXT NOT NULL,                  -- Bash, Read, Write, Edit, etc.
  input       TEXT NOT NULL,                  -- full input JSON (stringified)
  command     TEXT,                           -- extracted command string for Bash
  path        TEXT,                           -- extracted path for file tools
  decision    TEXT NOT NULL,                  -- allow | deny | defer | ask
  source      TEXT NOT NULL,                  -- user | rule | prediction | auto_afk
  confidence  REAL,                           -- 0.0–1.0, null if source=user
  rule_id     TEXT,                           -- which rule matched, if source=rule
  reason      TEXT,                           -- human-readable explanation
  project_cwd TEXT                            -- working directory at time of request
);

-- Deferral queue — destructive actions held for user review
CREATE TABLE IF NOT EXISTS deferred (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  session_id  TEXT NOT NULL,
  tool        TEXT NOT NULL,
  input       TEXT NOT NULL,
  command     TEXT,
  path        TEXT,
  reviewed    INTEGER DEFAULT 0,              -- 0 = pending, 1 = reviewed
  final       TEXT,                           -- allow | deny (set on review)
  review_ts   INTEGER
);

-- User-defined static rules
CREATE TABLE IF NOT EXISTS rules (
  id          TEXT PRIMARY KEY,               -- uuid
  created_ts  INTEGER NOT NULL,
  tool        TEXT NOT NULL,                  -- Bash | Read | Write | * (any)
  pattern     TEXT NOT NULL,                  -- glob or regex string
  action      TEXT NOT NULL,                  -- allow | deny
  label       TEXT,                           -- user-friendly description
  project     TEXT,                           -- null = global, path = project-scoped
  priority    INTEGER DEFAULT 0               -- higher = evaluated first
);

-- Session tracking
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  started_ts  INTEGER NOT NULL,
  ended_ts    INTEGER,
  project_cwd TEXT,
  total_req   INTEGER DEFAULT 0,
  auto_allow  INTEGER DEFAULT 0,
  auto_deny   INTEGER DEFAULT 0,
  user_allow  INTEGER DEFAULT 0,
  user_deny   INTEGER DEFAULT 0,
  deferred    INTEGER DEFAULT 0,
  tokens_est  INTEGER DEFAULT 0
);

-- Anomaly baselines (per project, per tool)
CREATE TABLE IF NOT EXISTS baselines (
  project_cwd TEXT NOT NULL,
  tool        TEXT NOT NULL,
  pattern     TEXT NOT NULL,                  -- normalized command/path pattern
  count       INTEGER DEFAULT 1,
  last_seen   INTEGER,
  PRIMARY KEY (project_cwd, tool, pattern)
);

CREATE INDEX IF NOT EXISTS idx_decisions_tool    ON decisions(tool);
CREATE INDEX IF NOT EXISTS idx_decisions_session ON decisions(session_id);
CREATE INDEX IF NOT EXISTS idx_decisions_ts      ON decisions(ts);
CREATE INDEX IF NOT EXISTS idx_deferred_reviewed ON deferred(reviewed);
```

---

## Core decision chain — `src/engine/chain.js`

This is the brain. Called on every `PermissionRequest`. Must complete in under 200ms for good UX.

```
Input: PermissionRequest JSON (tool, input, session_id, cwd)

Step 1 — Sensitive path guard
  Does this request touch .env, *.key, *.pem, secrets/, credentials/, ~/.ssh/?
  → Always interrupt user regardless of AFK mode
  → In AFK mode: send urgent phone notification, pause (do not auto-approve)

Step 2 — Prompt injection check
  Does input contain suspicious instruction patterns?
  ("ignore previous", "new system prompt", "disregard", etc.)
  → Deny immediately, log with reason

Step 3 — Destructive classifier
  Is this rm / rmdir / DROP / TRUNCATE / overwrite of existing file / kill / pkill?
  If YES:
    AFK mode ON  → run safety snapshot (git commit), add to deferral queue, return ask
                   (Claude Code skips and continues)
    AFK mode OFF → interrupt user immediately, do not auto-approve
  If NO → continue

Step 4 — Anomaly detector
  Is this pattern statistically unusual for this project?
  (e.g., reading /etc/hosts in a TypeScript repo, running curl in a migrations project)
  If anomaly score > threshold:
    AFK mode ON  → send phone notification, add to deferral queue
    AFK mode OFF → interrupt user with anomaly explanation

Step 5 — Static rules
  Query rules table for matching tool + pattern, sorted by priority DESC
  Match found? → return rule decision immediately, log with rule_id

Step 6 — Behavior prediction
  Query decisions table for this tool + pattern (last 90 days)
  Calculate: approval_rate weighted by recency
  confidence > 0.85 → auto-decide (allow or deny), log with confidence
  confidence 0.15–0.85 → escalate
  confidence < 0.15 → auto-deny

Step 7 — AFK mode fallback
  AFK mode ON?
    → auto-approve with logged assumption (source=auto_afk)
    → append to session digest for review on return
  AFK mode OFF?
    → return ask (Claude Code prompts user normally)

Step 8 — Phone notification (if configured)
  Send notification with tool + command summary + Approve/Deny buttons
  Wait up to config.timeout seconds for response
  Response received → apply decision
  Timeout → continue to step 9

Step 9 — Web dashboard queue
  Add to pending dashboard queue
  Wait up to config.dashboardTimeout seconds
  Timeout → fail closed → deny

Output: { behavior: "allow" | "deny" | "ask", reason: string }
```

---

## Destructive classifier — `src/engine/classifier.js`

Classify any `PermissionRequest` as destructive or safe. Must be fast (no I/O, pure logic).

**Destructive signals by tool:**

```
Bash commands:
  rm, rmdir, shred, truncate (file deletion)
  DROP TABLE, DROP DATABASE, DROP SCHEMA (SQL destructive)
  TRUNCATE TABLE (SQL data loss)
  kill, killall, pkill, pkexec (process termination)
  > file.txt (shell redirect overwriting existing file — check if file exists)
  git reset --hard, git clean -fd (destructive git)
  chmod 000, chown root (permission lockout)
  dd if=... of=/dev/... (disk writes)
  curl | bash, wget | sh (remote execution)

Write tool:
  Path exists on disk AND operation is overwrite (not append to new file)

Edit tool:
  Large deletions (>50 lines removed in one edit) — flag as potentially destructive

MultiEdit tool:
  Any single edit within that matches Write destructive criteria
```

**Safe signals (never flag as destructive):**
```
Read, Glob, Grep, LS, Search (read-only tools)
Write to a path that does not exist yet (new file creation)
npm install, yarn add, pip install (package management)
git status, git log, git diff, git add (non-destructive git)
Bash: echo, cat, ls, pwd, which, type, env (inspection)
```

Export a `classify(tool, input)` function returning:
```js
{
  destructive: boolean,
  reason: string,        // human-readable why
  severity: "critical" | "high" | "medium"  // critical = irreversible data loss
}
```

---

## Sensitive path guard — `src/engine/sensitive.js`

Hard-coded list of patterns that always require user attention, regardless of confidence or AFK mode.

```js
const SENSITIVE_PATTERNS = [
  /\.env(\.|$)/i,
  /\.env\.(local|production|staging|development)/i,
  /secrets?\//i,
  /credentials?\//i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /id_rsa/i,
  /id_ed25519/i,
  /\.ssh\//i,
  /\.aws\/credentials/i,
  /\.npmrc/i,
  /\.netrc/i,
  /keystore/i,
  /vault/i,
  /api.?key/i,
  /access.?token/i,
  /auth.?token/i,
]
```

Export `isSensitive(tool, input)` returning `{ sensitive: boolean, matched: string }`.

If sensitive, chain returns immediately with a special "requires_user" flag — never auto-approved in any mode.

---

## Behavior predictor — `src/engine/predictor.js`

Queries `decisions` table, returns a confidence score and predicted decision.

**Scoring algorithm:**

```
1. Extract normalized pattern from request:
   - Bash: strip arguments, keep base command + first path segment
     e.g. "npm run test:unit --watch" → "npm run test:*"
   - Write/Read/Edit: strip filename, keep directory path
     e.g. "/home/darshan/project/src/components/Button.tsx" → "src/components/*"

2. Query decisions for: same tool + pattern matches (LIKE query)
   Filter: last 90 days only

3. For each matching decision:
   age_weight = exp(-days_old / 30)   -- recent decisions count more
   contribution = age_weight * (1 if allow, -1 if deny)

4. confidence = (sum of allow contributions) / (sum of all contributions)
   Normalize to 0.0–1.0

5. If total sample size < 3: confidence = 0.5 (not enough data, escalate)

6. Return:
   {
     confidence: 0.0–1.0,
     predicted: "allow" | "deny",
     sample_size: number,
     explanation: "Approved 8 of 9 similar Bash commands in the last 14 days"
   }
```

---

## AFK state — `src/afk/state.js`

State file: `~/.claude/afk/state.json`

```json
{
  "afk": false,
  "afk_since": null,
  "afk_until": null,
  "session_id": "uuid",
  "auto_afk_minutes": 15,
  "digest": []
}
```

Functions to export:
- `isAfk()` — reads state file synchronously, returns boolean
- `setAfk(on, durationMinutes?)` — writes state file
- `appendDigest(entry)` — appends to digest array for session summary
- `getAndClearDigest()` — returns digest array and clears it (called on `/afk off`)
- `getSessionId()` — returns current session UUID

State file is read on every hook invocation. No daemon required.

---

## Auto-commit safety net — `src/safety/snapshot.js`

Before any destructive action is deferred or approved, run this first.

```js
async function snapshot(cwd, reason) {
  // 1. Check if cwd is a git repo (git rev-parse --git-dir)
  // 2. If not a git repo: skip silently, log warning
  // 3. If git repo:
  //    git add -A
  //    git commit -m "afk: checkpoint before ${reason} [skip ci]"
  //    log commit hash to decisions table
  // 4. Return { snapshotted: boolean, commit: string | null }
}
```

This runs synchronously before returning the defer decision. If it fails (dirty worktree, no git), log but do not block.

---

## Anomaly detector — `src/engine/anomaly.js`

Detects statistically unusual requests relative to the project's baseline activity.

```
On every request:
1. Look up project baseline (tool + normalized pattern) in baselines table
2. If pattern never seen before in this project:
   anomaly_score = 1.0 (completely new)
3. If pattern seen but rarely (< 3 times):
   anomaly_score = 0.7
4. If pattern is common (>= 10 times):
   anomaly_score = 0.0
5. Additionally flag: any Bash command reading outside project cwd
   (accessing /etc, /usr, ~/ from a project subdir)

After decision: always upsert baselines table (increment count, update last_seen)

Return: { anomalous: boolean, score: number, reason: string }
```

---

## Notification system — `src/notify/`

### ntfy.js

```js
async function notify(config, { tool, command, path, requestId }) {
  // POST to config.ntfyServer/config.topic
  // Headers: Title, Priority (urgent for destructive), Actions (approve/deny)
  // Action URLs post to config.topic-response with requestId
  // SSE subscriber on topic-response waits up to config.timeout ms
  // Returns: "allow" | "deny" | "timeout"
}
```

### telegram.js

```js
async function notify(config, { tool, command, path, requestId }) {
  // Send message via Telegram Bot API
  // Inline keyboard: [Approve] [Deny]
  // Poll for callback query up to config.timeout ms
  // Returns: "allow" | "deny" | "timeout"
}
```

Config lives in `~/.claude/afk/config.json`:
```json
{
  "notifications": {
    "provider": "ntfy",
    "ntfyServer": "https://ntfy.sh",
    "ntfyTopic": "afk-abc123",
    "telegramToken": null,
    "telegramChatId": null,
    "timeout": 120,
    "onlyFor": ["high", "critical"]
  }
}
```

---

## Web dashboard — `src/dashboard/`

Local Express server, started lazily when `/afk:review` is invoked or when a pending item enters the queue.

Default port: `6789`. Binds to `127.0.0.1` only.

### API endpoints

```
GET  /api/status          — AFK state, session stats, queue count
GET  /api/decisions       — paginated decision history (query: page, tool, source, date)
GET  /api/queue           — all pending deferred items
POST /api/queue/:id       — review a deferred item { action: "allow" | "deny" }
GET  /api/rules           — list all rules
POST /api/rules           — create a new rule
DELETE /api/rules/:id     — delete a rule
GET  /api/stats           — aggregated stats for dashboard charts
GET  /api/digest          — current session digest
POST /api/afk             — toggle AFK { on: boolean, duration?: number }
GET  /api/export          — download decisions as CSV or JSON (query: format)
```

### Dashboard UI pages

- **Overview**: AFK toggle, session stats (auto-rate, deferred count, today's decisions)
- **Queue**: deferred actions waiting for review, approve/deny each inline
- **History**: filterable table of all decisions, source badge (user/auto/rule/prediction)
- **Patterns**: heatmap of which tools/commands are auto-approved vs always flagged
- **Rules**: add/edit/delete static rules with a simple form
- **Digest**: narrative of what happened during last AFK session

Keep the UI simple — plain HTML + vanilla JS is fine. No React, no bundler. Must work offline (no CDN dependencies).

---

## Slash commands

### `commands/afk.md`

```markdown
---
name: afk
description: Toggle AFK mode. Claude will handle permissions automatically while you're away.
---

Usage:
- /afk on — enable AFK mode
- /afk off — disable AFK mode, show deferred queue if any
- /afk status — show current state and queue count
- /afk 30m — enable AFK mode for 30 minutes, then auto-return

When AFK mode is on:
- Safe actions are auto-approved based on your history
- Sensitive paths always require your attention (phone notification sent)
- Destructive actions are deferred to a queue — Claude skips them and continues
- On /afk off, you'll review all deferred actions before Claude proceeds

All decisions are logged. Run /afk:review to see the full dashboard.
```

### `commands/afk-stats.md`

```markdown
---
name: afk:stats
description: Show a summary of today's AFK decisions in the terminal.
---

Prints:
- Total requests today
- Auto-approved (with %)
- Auto-denied (with %)
- User-reviewed
- Deferred (pending in queue)
- Sensitive path alerts
- Current AFK state
- Top 3 auto-approved patterns
```

### `commands/afk-rules.md`

```markdown
---
name: afk:rules
description: Manage static approval rules.
---

Usage:
- /afk:rules — list all rules
- /afk:rules add — interactive: tool, pattern, action (allow/deny), label
- /afk:rules remove <id> — delete a rule by ID
- /afk:rules project — list rules scoped to current project only

Rules are evaluated before behavior prediction. Higher priority rules run first.
```

### `commands/afk-review.md`

```markdown
---
name: afk:review
description: Open the AFK web dashboard in your browser.
---

Starts the local dashboard server if not already running (port 6789).
Opens http://localhost:6789 in your default browser.
Dashboard shows: decision history, deferred queue, learned patterns, rule editor.
```

### `commands/afk-reset.md`

```markdown
---
name: afk:reset
description: Clear AFK decision history and start fresh.
---

Prompts for confirmation before wiping.
Deletes: all decisions, all sessions, all deferred items, all learned baselines.
Preserves: rules, notification config, AFK settings.
```

---

## Config file — `~/.claude/afk/config.json`

```json
{
  "version": 1,
  "afk": {
    "autoAfkMinutes": 15,
    "autoReturn": true
  },
  "thresholds": {
    "autoApprove": 0.85,
    "autoDeny": 0.15,
    "anomalyFlag": 0.7
  },
  "safety": {
    "snapshotBeforeDestructive": true,
    "alwaysInterruptSensitive": true,
    "failClosed": true
  },
  "notifications": {
    "provider": null,
    "timeout": 120,
    "dashboardTimeout": 300,
    "onlyFor": ["high", "critical"]
  },
  "dashboard": {
    "port": 6789,
    "autoOpen": true
  },
  "digest": {
    "enabled": true,
    "showOnAfkOff": true
  }
}
```

---

## Hook entry point — `src/hook.js`

This is what Claude Code calls. It receives a PermissionRequest JSON on stdin and must write a decision JSON to stdout.

```js
// src/hook.js
import { chain } from './engine/chain.js'
import { db } from './store/db.js'
import { isAfk } from './afk/state.js'

// Read stdin
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => { input += chunk })
process.stdin.on('end', async () => {
  try {
    const request = JSON.parse(input)
    const result = await chain(request)
    process.stdout.write(JSON.stringify({ behavior: result.behavior }))
    process.exit(0)
  } catch (err) {
    // Fail closed — if AFK itself errors, deny the request
    process.stderr.write(`afk error: ${err.message}\n`)
    process.stdout.write(JSON.stringify({ behavior: 'ask' }))
    process.exit(0)
  }
})
```

The hook must always exit 0. Never crash. Never hang beyond 30 seconds. If the full chain times out, fail closed to `ask`.

---

## PermissionRequest input format

Claude Code pipes this JSON to the hook on stdin:

```json
{
  "tool": "Bash",
  "input": {
    "command": "rm -rf dist/"
  },
  "session_id": "abc-123",
  "cwd": "/home/darshan/projects/shooterista"
}
```

Tool-specific input shapes:
```
Bash:    { "command": "string" }
Read:    { "file_path": "string" }
Write:   { "file_path": "string", "content": "string" }
Edit:    { "file_path": "string", "old_string": "string", "new_string": "string" }
Glob:    { "pattern": "string" }
Grep:    { "pattern": "string", "path": "string" }
```

Output must be:
```json
{ "behavior": "allow" }
{ "behavior": "deny" }
{ "behavior": "ask" }
```

---

## Implementation order

Build in this order. Each phase is independently testable.

### Phase 1 — Foundation
1. `src/store/db.js` — SQLite setup with full schema, WAL mode, migrations
2. `src/store/history.js` — log decision, query by tool/pattern
3. `src/afk/state.js` — read/write AFK state file
4. `src/hook.js` — bare entry point that reads stdin, writes stdout, calls chain stub
5. `.claude-plugin/plugin.json` — plugin manifest
6. `scripts/setup.js` — post-install: create ~/.claude/afk/, initialize db

Test: install locally, confirm hook receives and returns JSON correctly.

### Phase 2 — Decision chain (core value)
1. `src/engine/sensitive.js` — sensitive path patterns
2. `src/engine/classifier.js` — destructive classifier
3. `src/engine/rules.js` — static rule matching against db
4. `src/engine/predictor.js` — confidence scoring from history
5. `src/engine/chain.js` — full fallback chain wiring all of the above

Test: write fixtures for each tool type, assert correct decisions.

### Phase 3 — AFK + safety
1. `src/safety/snapshot.js` — git auto-commit before destructive
2. `src/store/queue.js` — deferral queue CRUD
3. `src/afk/detector.js` — idle detection, auto AFK
4. `src/afk/digest.js` — session narrative builder
5. `/afk` slash command

Test: simulate AFK session, verify queue populates and snapshot commits happen.

### Phase 4 — Anomaly detection
1. `src/engine/anomaly.js` — baseline tracking + anomaly scoring
2. Wire into chain between classifier and rules

Test: seed baselines, send unusual request, assert anomaly flagged.

### Phase 5 — Notifications
1. `src/notify/ntfy.js` — ntfy sender + SSE listener
2. `src/notify/telegram.js` — Telegram bot sender + poller
3. Wire into chain at step 8

Test: mock ntfy responses, assert correct decision returned.

### Phase 6 — Dashboard
1. `src/dashboard/server.js` — Express server
2. `src/dashboard/api.js` — all REST endpoints
3. `src/dashboard/ui/` — plain HTML/JS dashboard
4. `/afk:review`, `/afk:stats`, `/afk:rules`, `/afk:reset` commands

Test: start server, hit endpoints, assert correct data shapes.

### Phase 7 — Polish + publish
1. `src/store/session.js` — session tracking + token estimation
2. Weekly digest (cron or on-session-start)
3. Trust profiles per project / per branch
4. Audit export (CSV/JSON)
5. Marketplace catalog (`marketplace/marketplace.json`)
6. README with install instructions, philosophy section, feature list
7. Submit to official Anthropic marketplace

---

## Coding standards

- ESM modules throughout (`"type": "module"` in package.json)
- No `console.log` in production paths — use `process.stderr.write` for debug only
- All database operations synchronous (better-sqlite3 is sync by design)
- All async operations (notify, dashboard) must have explicit timeouts
- Every function has a JSDoc comment with `@param` and `@returns`
- Error handling: catch everything in the hook entry point, never let it crash
- No external network calls in the decision chain itself (classify, predict, rules are all local)
- Test file for every engine module — at minimum happy path + destructive case

---

## Testing approach

Use Node.js built-in `node:test`. No Jest, no Mocha.

```js
// test/classifier.test.js
import { test } from 'node:test'
import assert from 'node:assert'
import { classify } from '../src/engine/classifier.js'

test('rm -rf is destructive', () => {
  const result = classify('Bash', { command: 'rm -rf dist/' })
  assert.strictEqual(result.destructive, true)
  assert.strictEqual(result.severity, 'critical')
})

test('npm install is safe', () => {
  const result = classify('Bash', { command: 'npm install' })
  assert.strictEqual(result.destructive, false)
})

test('Write to new file is safe', () => {
  // mock fs.existsSync to return false
  const result = classify('Write', { file_path: '/tmp/new-file.txt', content: 'hello' })
  assert.strictEqual(result.destructive, false)
})
```

Run tests: `node --test test/*.test.js`

---

## Known constraints and edge cases

- **Hook timeout**: Claude Code kills the hook process after ~30 seconds. All network waits (notifications) must have hard timeouts below this.
- **Concurrent sessions**: Multiple Claude Code sessions can run simultaneously. SQLite WAL mode handles concurrent reads. Writes use transactions.
- **No daemon**: AFK is stateless — reads state file on every invocation. No background process required.
- **Git not present**: Snapshot feature degrades gracefully if not a git repo.
- **First-time use**: Predictor has no history on first install. It returns confidence=0.5 for all requests until enough data accumulates (threshold: 3 decisions per pattern). During this period, chain falls through to user prompt (AFK mode) or asks normally.
- **Large inputs**: Write tool can have huge content strings. Extract only the path for classification and prediction — never store full file content in decisions table.
- **Windows paths**: Normalize all paths to forward-slash internally. Test on Windows with WSL.

---

## Files NOT to create

- Do not create a `.env` file (config goes in `~/.claude/afk/config.json`)
- Do not create lockfiles manually (npm handles package-lock.json)
- Do not create any files in `~/.claude/settings.json` directly — the plugin manifest handles hook registration
- Do not create a separate daemon/service file — AFK is invoked per-request, not as a server

---

## README requirements

The README must open with the philosophy statement verbatim. Then:
1. One-sentence description
2. Install command (two lines: marketplace add + plugin install)
3. Feature list (what it does, not how)
4. How it works (the decision chain as a simple diagram)
5. AFK mode explanation
6. Configuration reference
7. Commands reference
8. Contributing guide
9. License

No screenshots until the dashboard UI is complete. Use text diagrams until then.

---

## Marketplace catalog — `marketplace/marketplace.json`

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

---

## Session digest format

Generated by `src/afk/digest.js` when `/afk off` is run.

```
AFK session digest — 47 minutes AFK

Auto-approved (23 actions):
  • Read × 12 — src/components/ files
  • Bash × 8 — npm run build, npm test
  • Write × 3 — new files in src/utils/

Deferred for your review (3 actions):
  • rm -rf dist/  [review required]
  • Write to .env.local  [sensitive path]
  • DROP TABLE sessions  [critical — database]

Anomalies flagged (1):
  • curl https://external-api.com/data — unusual for this project

Auto-deny (1):
  • Bash: eval $(cat suspicious.sh) — injection pattern detected

Run /afk:review to open the dashboard and process deferred actions.
```

---

## What success looks like

At v1.0:
- Zero configuration required to get value (works out of the box, learns immediately)
- AFK session completes without stalling, digest on return
- No false positives on common dev commands (npm, git, file writes)
- Deferred queue surfaces dangerous actions clearly with enough context to decide
- Dashboard accessible and useful within 30 seconds of opening

At community scale (Superpowers benchmark):
- Published to official Anthropic marketplace
- Rule set sharing — users publish named rule packs (e.g. "safe for Next.js projects")
- Cross-platform: Codex and OpenCode support
- Weekly digest emails (optional)
- 1,000+ GitHub stars within 60 days of launch
