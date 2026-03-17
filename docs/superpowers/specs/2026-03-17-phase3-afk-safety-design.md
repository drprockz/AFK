# AFK Phase 3 Design — AFK + Safety

**Date:** 2026-03-17
**Scope:** Phase 3 of the AFK plugin: safety snapshot, deferral queue, idle detector, session digest, CLI script, and `/afk` slash command.
**Builds on:** `docs/superpowers/specs/2026-03-16-afk-core-design.md` (Phase 1+2 design decisions)

---

## Decisions Made During Brainstorming

### Decision 1: Idle detection via request-gap (not daemon)

The `detector.js` module uses request-gap detection: each hook invocation updates `last_request_ts` in the state file. On the next invocation, if the elapsed time since `last_request_ts` exceeds `auto_afk_minutes`, AFK is auto-enabled. No background daemon, no OS-level idle polling — stateless, per-request.

`auto_afk_minutes: 0` disables auto-AFK entirely.

### Decision 2: Deferred queue shown inline on `/afk off`

When the user runs `/afk off`, any pending deferred items are printed to the terminal. Claude asks the user to approve or deny each one inline. No dashboard required (Phase 6). This uses the existing `deferred` table.

### Decision 3: CLI script for slash command execution

The `/afk` slash command invokes `node scripts/afk-cli.js <subcommand>` via Claude's Bash tool. Claude reads stdout and formats the response. This is reliable, testable, and consistent with the project's "no magic, plain Node.js" philosophy.

### Decision 4: Direct chain wiring (no middleware abstraction)

Snapshot and queue calls go directly into `chain.js` at the existing Phase 3 comment in step 3 (destructive AFK-ON path). No new abstraction layers.

---

## 1. Safety Snapshot — `src/safety/snapshot.js`

### Purpose

Create a git checkpoint before any destructive action is deferred. Gives the user a recoverable state in case they later approve a destructive deferred action.

### CLAUDE.md deviation: commit hash in `reason` field

CLAUDE.md says "log commit hash to decisions table." This is implemented via the `reason` field of the deferred `logDecision` call instead, because the `decisions` schema has no dedicated `commit_hash` column. Adding a column is out of scope for Phase 3. This is an intentional deviation — the hash is preserved in the audit log via `reason`.

### Interface

```js
/**
 * Creates a git checkpoint before a destructive deferred action.
 * Runs git add -A + git commit. Non-blocking on failure.
 * @param {string} cwd — project working directory
 * @param {string} reason — human-readable reason (used in commit message)
 * @returns {Promise<{ snapshotted: boolean, commit: string | null }>}
 */
export async function snapshot(cwd, reason)
```

### Behavior

1. Run `git rev-parse --git-dir` in `cwd`. If exit code non-zero → not a git repo → return `{ snapshotted: false, commit: null }`.
2. Run `git add -A` in `cwd`.
3. Run `git commit -m "afk: checkpoint before ${reason} [skip ci]"` in `cwd`.
4. If commit exits non-zero with "nothing to commit" in stdout/stderr → working tree clean → return `{ snapshotted: false, commit: null }`. Not an error.
5. On success → parse commit hash from stdout (format: `[branch hash]`) → return `{ snapshotted: true, commit: '<hash>' }`.
6. Any other failure (git not installed, permission error, pre-commit hook rejection, merge conflict) → `process.stderr.write` the error → return `{ snapshotted: false, commit: null }`. Never throws. Never blocks.

### Mid-commit failure note

If `git add -A` succeeds but `git commit` fails (e.g., pre-commit hook rejection, merge conflict), the working tree will be left with staged changes. **Do not attempt `git reset HEAD` or any cleanup** — leave staged state as-is. The user's working tree is unchanged from their perspective (staged ≠ committed). This avoids introducing any new file system mutations beyond what git itself did.

### No internal timeout

`snapshot()` does not impose an internal timeout on git commands. If git is slow (large repo, slow disk), it consumes deadline budget. The caller's deadline guard (`remaining <= 3000`) is the only protection. This is a known limitation — acceptable for Phase 3.

### Constraints

- All git commands run with `{ cwd }` option via `node:child_process` `execFile` (not `exec` — avoids shell injection on `cwd` or `reason`).
- Uses Node.js built-in `node:child_process` — no new dependencies.
- Snapshot result is NOT logged to the `decisions` table as a separate row — the commit hash is included in the `reason` field of the deferred `logDecision` call (see Section 3).
- Counts against the deadline budget in `chain.js` (async, awaited before queue insert).

---

## 2. Deferral Queue — `src/store/queue.js`

### Purpose

CRUD operations over the existing `deferred` table. Used by `chain.js` (enqueue) and `afk-cli.js` (list, resolve).

### Interface

```js
/**
 * Inserts a new deferred item into the queue.
 * @param {object} opts
 * @param {number} opts.decisionsId — FK to decisions.id of the originating defer row
 * @param {string} opts.sessionId
 * @param {string} opts.tool
 * @param {object} opts.input — raw original input (unsanitized, for human review)
 * @param {string|null} opts.command
 * @param {string|null} opts.path
 * @returns {number} new deferred row id
 */
export function enqueueDeferred({ decisionsId, sessionId, tool, input, command, path })

/**
 * Returns all unreviewed deferred items, oldest first.
 * @returns {Array<object>} deferred rows with reviewed=0
 */
export function getPendingItems()

/**
 * Marks a deferred item as reviewed with a final decision.
 * @param {number} id — deferred row id
 * @param {'allow'|'deny'} final
 * @returns {boolean} true if row was updated, false if id did not exist
 */
export function resolveItem(id, final)

/**
 * Returns the count of unreviewed deferred items.
 * @returns {number}
 */
export function getPendingCount()
```

### Behavior

- All functions are synchronous (better-sqlite3).
- `enqueueDeferred` stores a size-capped JSON string: serialize `input` with `JSON.stringify(input)`. If the resulting string exceeds **10 KB**, truncate the `content` field on the input object before serializing (Write/Edit tools carry large file content). Specifically: if `typeof input.content === 'string' && input.content.length > 5000`, replace it with `input.content.slice(0, 5000) + '...[truncated]'` before JSON.stringify. All other fields are stored verbatim. This preserves human-review context (file path, command) while preventing multi-megabyte blobs in SQLite.
- `resolveItem` returns `boolean`: `true` if a row was updated, `false` if `id` did not exist (better-sqlite3 `stmt.run().changes === 0`). Sets `reviewed=1`, `final`, `review_ts=Date.now()` on success.
- No cascade deletes. Reviewed items remain in the table for audit.

---

## 3. Chain Wiring — `src/engine/chain.js` (modification)

### Critical implementation note: call `logDecision()` directly, not via `log()`

The existing `log()` helper in `chain.js` discards the return value of `logDecision()`. The AFK-ON destructive path needs `lastInsertRowid` to use as the FK for `enqueueDeferred`. Therefore, **this path must call `logDecision()` directly** (bypassing the `log()` wrapper) and capture the returned row id.

The `log()` helper continues to be used for all other decision paths (sensitive, injection, rules, predictor, AFK fallback).

### Wiring sequence (replaces Phase 3 comment in step 3)

```
AFK ON + destructive:
  1. Check deadline budget: if remaining <= 3000ms → skip snapshot, note in reason
  2. const { snapshotted, commit } = await snapshot(cwd, destructive.reason)
  3. const snapshotNote = snapshotted ? `Snapshot: ${commit}` : 'Snapshot: skipped'
  4. const decisionsId = logDecision({   // called DIRECTLY, not via log()
       session_id, tool, input, command, path,
       decision: 'defer',
       source: 'auto_defer',
       project_cwd: cwd,
       reason: `Destructive: ${destructive.reason} (${destructive.severity}). ${snapshotNote}`
     })
  5. enqueueDeferred({ decisionsId, sessionId: session_id, tool, input, command, path })
  6. appendDigest({ tool, command, path, decision: 'defer', ts: Date.now() })
  7. return { behavior: 'ask', reason: `Destructive action deferred: ${destructive.reason}` }
```

Step 6 (`appendDigest`) is essential — deferred items must appear in the digest under "Deferred for your review." Without this call, the digest would only show auto-approved items.

### Deadline guard for snapshot

```js
const remaining = deadline - Date.now()
if (remaining <= 3000) {
  // Not enough time to snapshot safely — skip it, still defer
  snapshotResult = { snapshotted: false, commit: null }  // use this in snapshotNote
} else {
  snapshotResult = await snapshot(cwd, destructive.reason)
}
```

The 3000ms buffer (vs 2000ms for notifications in Phase 5/6) accounts for git operations being slower than network calls. `snapshot()` has no internal timeout — the deadline guard is the only protection.

### `checkAndAutoAfk()` insertion point

Insert `checkAndAutoAfk()` between the deadline guard and the existing `isAfk()` call. The existing `isAfk()` line is NOT moved:

```js
export async function chain(request, deadline) {
  if (Date.now() >= deadline) return { behavior: 'ask', reason: 'deadline expired' }

  checkAndAutoAfk()           // ← NEW: may flip state to AFK on
  const afkOn = isAfk()       // ← EXISTING: unchanged, reads updated state
  ...
}
```

---

## 4. Idle Detector — `src/afk/detector.js`

### Purpose

Auto-enable AFK mode when Claude has been idle for longer than `auto_afk_minutes`. Called at chain entry on every hook invocation.

### Interface

```js
/**
 * Checks if the user has been idle long enough to auto-enable AFK.
 * Updates last_request_ts unconditionally on every call.
 * Reads auto_afk_minutes from state file (not config.json).
 * @returns {void}
 */
export function checkAndAutoAfk()
```

### Behavior

1. Read state file (via `readState()` — internal to `state.js`, not exported; detector imports from `state.js`'s public API only).
2. If `state.auto_afk_minutes === 0` → skip (auto-AFK disabled). Still update `last_request_ts`.
3. If `state.afk === true` → skip (already in AFK mode, don't re-trigger). Still update `last_request_ts`.
4. If `state.last_request_ts` is `null` → first ever invocation → no idle check, just set `last_request_ts = Date.now()`.
5. If `Date.now() - state.last_request_ts > state.auto_afk_minutes * 60 * 1000`:
   - Call `setAfk(true)` (no duration — stays on until user calls `/afk off`)
   - `process.stderr.write(`afk: auto-AFK enabled after ${elapsedMinutes} minutes idle\n`)`
6. Write `last_request_ts = Date.now()` to state file (always, regardless of whether AFK was triggered).

### `auto_afk_minutes` source of truth

`checkAndAutoAfk()` reads `auto_afk_minutes` from the **state file** (`state.auto_afk_minutes`), not from `config.json`. This is consistent with `state.js`'s pattern of reading all runtime state from one file. `setup.js` copies `config.json`'s `afk.autoAfkMinutes` into the initial state file on first install. If the user wants to change the threshold after install, they update the state file directly or a future `/afk:config` command (Phase 7).

### State file additions (modification to `src/afk/state.js`)

One new field added to `defaultState()` in `state.js`:

```js
{
  last_request_ts: null  // ← NEW: null on first install
  // auto_afk_minutes: 15 already exists — do NOT add it again
}
```

`auto_afk_minutes: 15` **already exists** in the current `defaultState()` (confirmed in `src/afk/state.js`). Only `last_request_ts` is new.

### `checkAndAutoAfk()` uses `state.js` public API

`detector.js` cannot import internal `readState()`/`writeState()` (they are not exported from `state.js`). Instead:
- Read state by calling `getSessionId()` or another exported function… but actually state.js needs to export a way to update `last_request_ts`.
- **Simplest approach:** Export a new function from `state.js`:

```js
/**
 * Updates last_request_ts to now. Used by detector.js.
 * @returns {void}
 */
export function touchLastRequestTs()
```

And export a read function for the detector:

```js
/**
 * Returns the full current state object. Read-only snapshot.
 * @returns {object}
 */
export function getState()
```

`checkAndAutoAfk()` then calls `getState()` to read, `setAfk(true)` to enable AFK, and `touchLastRequestTs()` to update the timestamp. No direct file I/O in `detector.js`.

---

## 5. Session Digest — `src/afk/digest.js`

### Purpose

Pure formatting function — turns the digest array from state into a human-readable narrative string. No I/O, no DB access.

### Interface

```js
/**
 * Builds a human-readable AFK session digest string.
 * Pure function — no I/O, no DB access.
 * @param {object[]} entries — digest entries from state.digest (decision: 'allow' | 'defer')
 * @param {number} pendingCount — number of unreviewed deferred items
 * @returns {string} formatted digest text
 */
export function buildDigest(entries, pendingCount)
```

### Grouping logic

- Entries with `decision='allow'` are grouped by tool. Within each tool group, unique commands/paths are listed (max 3, then "and N more").
- Entries with `decision='defer'` are listed individually with a `[N]` index — these map to the deferred queue IDs shown by `afk-cli.js off`.
- Entries with any other `decision` value (e.g., `'ask'`, `'deny'`) are **silently ignored** — only auto-approved and deferred actions are surfaced in the digest.
- If `entries` is empty and `pendingCount === 0` → return `"No activity during AFK session."`.
- If `entries` is empty but `pendingCount > 0` → show only the deferred section (using pendingCount for the count, since entries may not include older deferred items from a previous AFK session).

### Output format

```
AFK session digest — 23 actions while away

Auto-approved (20):
  • Bash ×12 — npm run build, npm test
  • Write ×5  — new files in src/components/
  • Read ×3   — src/components/*

Deferred for your review (3):
  • [1] Bash: rm -rf dist/
  • [2] Bash: DROP TABLE logs
  • [3] Write: /projects/app/.env.local

Run /afk:review to process deferred items in the dashboard (Phase 6).
```

### Digest entry shape

Each entry in `state.digest` (appended by `chain.js`'s `appendDigest` call):

```js
{ tool, command, path, decision: 'allow' | 'defer', ts: number }
```

---

## 6. CLI Script — `scripts/afk-cli.js`

### Purpose

Executable Node.js script invoked by the `/afk` slash command. Bridges Claude's Bash tool calls to the AFK state and queue modules.

### Subcommands

```
node scripts/afk-cli.js on                      — enable AFK mode
node scripts/afk-cli.js off                     — disable AFK, print digest + pending queue
node scripts/afk-cli.js status                  — print current AFK state + queue count
node scripts/afk-cli.js 30m                     — enable AFK for 30 minutes
node scripts/afk-cli.js 2h                      — enable AFK for 2 hours
node scripts/afk-cli.js resolve <id> <allow|deny>  — resolve a deferred item by id
```

### Duration parsing

`parseDuration(str)` → minutes or null:

```js
function parseDuration(str) {
  const hours = Number(str.match(/(\d+)h/)?.[1] ?? 0)
  const mins  = Number(str.match(/(\d+)m/)?.[1] ?? 0)
  const total = hours * 60 + mins
  return total > 0 ? total : null
}
```

Examples: `30m` → 30, `2h` → 120, `1h30m` → 90, `abc` → null (treated as `on` with no duration).

### `off` subcommand behavior

1. If AFK is currently OFF → print `"AFK mode is already off."` then continue to show digest and queue (useful for reviewing the queue even when not in AFK mode).
2. Call `setAfk(false)`.
3. Call `getAndClearDigest()` from `state.js`.
4. Call `getPendingItems()` from `queue.js`.
5. Print `buildDigest(entries, pendingCount)`.
6. If pending items exist, print each one with its queue id.

### `off` subcommand output

```
AFK mode: OFF

AFK session digest — 23 actions while away
...

Pending deferred actions (3):
  [id=4] Bash: rm -rf dist/           ts: 2026-03-17 14:23
  [id=5] Bash: DROP TABLE logs        ts: 2026-03-17 14:31
  [id=6] Write: /projects/app/.env    ts: 2026-03-17 14:45

To resolve: node scripts/afk-cli.js resolve <id> allow|deny
```

### `resolve` subcommand behavior

1. Parse `id` (integer) and `final` ('allow' | 'deny') from argv.
2. If `id` is not a valid integer or `final` is not 'allow'|'deny' → print usage error to stdout, exit 0.
3. Call `resolveItem(id, final)` from `queue.js`.
4. If `resolveItem` was a no-op (id did not exist) → print `"No pending item with id ${id}."` to stdout.
5. Otherwise → print `"Resolved [id=${id}]: ${final}."` to stdout.

### `status` subcommand output

```
AFK mode: ON (since 14:05, auto-returns at 15:05)
Pending deferred: 3 actions
Session digest: 20 auto-approved since AFK started
```

Or if off:
```
AFK mode: OFF
Pending deferred: 0 actions
Auto-AFK: enabled (triggers after 15 min idle)
```

### Error handling

- Unknown subcommand → print usage to stdout, exit 0.
- Module import errors → `process.stderr.write`, print friendly error to stdout, exit 0.
- Always exits 0 — Claude reads stdout.

---

## 7. Slash Command — `commands/afk.md`

### Path resolution

Claude Code slash commands have access to `$PLUGIN_DIR` (the absolute path to the installed plugin directory) when the plugin is installed via the marketplace. For local dev (this repo), the absolute path is used directly.

The slash command uses `$PLUGIN_DIR` as an environment variable in the shell command. If `$PLUGIN_DIR` is not set (local dev), the command falls back to finding `afk-cli.js` relative to the repo root using `git rev-parse --show-toplevel`.

### File content

```markdown
---
name: afk
description: Toggle AFK mode on/off, set a duration, or check status
---

Run the AFK CLI with the user's argument:

```bash
SCRIPT="${PLUGIN_DIR}/scripts/afk-cli.js"
if [ -z "$PLUGIN_DIR" ] || [ ! -f "$SCRIPT" ]; then
  SCRIPT="$(git rev-parse --show-toplevel 2>/dev/null)/scripts/afk-cli.js"
fi
node "$SCRIPT" <arg>
```

Where `<arg>` is exactly what the user typed after `/afk` (e.g. `on`, `off`, `30m`, `status`).
If the user typed `/afk` with no argument, use `status`.

Read the output and present it clearly to the user.

If the output lists pending deferred items, ask the user to approve or deny each one.
For each decision, run: `node "$SCRIPT" resolve <id> allow|deny`
Confirm each resolution to the user as you go.
```

---

## 8. New `state.js` exports (modification to `src/afk/state.js`)

Two new exported functions needed by `detector.js`:

```js
/**
 * Returns the full current state object. Read-only snapshot.
 * @returns {object}
 */
export function getState()

/**
 * Updates last_request_ts to the current time.
 * Called by detector.js on every hook invocation.
 * MUST be implemented as read-modify-write: readState() → spread result → set last_request_ts=Date.now() → writeState().
 * Must NOT spread defaultState() as the base — that would reset afk, session_id, and other live fields.
 * @returns {void}
 */
export function touchLastRequestTs()
```

---

## 9. Minimum Test Cases Per New File

### `test/snapshot.test.js` (4 tests)
1. Returns `{ snapshotted: true, commit: <hash> }` when git repo has changes
2. Returns `{ snapshotted: false, commit: null }` when working tree is clean (nothing to commit)
3. Returns `{ snapshotted: false, commit: null }` when cwd is not a git repo
4. Never throws — returns gracefully on git failure

### `test/queue.test.js` (4 tests)
1. `enqueueDeferred` inserts row and returns numeric id
2. `getPendingItems` returns only unreviewed rows, oldest first
3. `resolveItem` marks row reviewed and sets final
4. `resolveItem` with non-existent id is a silent no-op (no throw)

### `test/detector.test.js` (5 tests)
1. No auto-AFK on first invocation (`last_request_ts` is null)
2. No auto-AFK when gap is less than threshold
3. Auto-AFK triggered when gap exceeds threshold
4. No auto-AFK when `auto_afk_minutes === 0` (disabled)
5. `last_request_ts` always updated, even when auto-AFK is skipped

### `test/digest.test.js` (4 tests)
1. Groups allow entries by tool with counts
2. Lists defer entries individually with index
3. Returns "No activity during AFK session." when entries empty and pendingCount=0
4. Ignores entries with unknown decision values

### `test/afk-cli.test.js` (4 tests)
1. `status` prints current state without crashing
2. `on` enables AFK and prints confirmation
3. `off` disables AFK and prints digest
4. `resolve <id> allow` resolves item and prints confirmation

### `test/chain.test.js` additions (2 new tests)
1. AFK ON + destructive → snapshot called, item in deferred queue, `ask` returned
2. AFK ON + destructive with expired deadline budget → snapshot skipped, item still deferred

---

## 10. New Files Summary

| File | Type | Purpose |
|---|---|---|
| `src/safety/snapshot.js` | new | git checkpoint before defer |
| `src/store/queue.js` | new | deferral queue CRUD |
| `src/afk/detector.js` | new | request-gap auto-AFK |
| `src/afk/digest.js` | new | pure digest formatter |
| `scripts/afk-cli.js` | new | CLI for slash command |
| `commands/afk.md` | new | `/afk` slash command prompt |
| `src/engine/chain.js` | modify | wire snapshot+queue+appendDigest into step 3 AFK-ON path; add `checkAndAutoAfk()` call before `isAfk()`; call `logDecision()` directly in AFK-ON destructive path |
| `src/afk/state.js` | modify | add `last_request_ts: null` to `defaultState()`; export `getState()` and `touchLastRequestTs()` |
| `test/snapshot.test.js` | new | 4 tests |
| `test/queue.test.js` | new | 4 tests |
| `test/detector.test.js` | new | 5 tests |
| `test/digest.test.js` | new | 4 tests |
| `test/afk-cli.test.js` | new | 4 tests |
| `test/chain.test.js` | modify | 2 new AFK-ON destructive tests |

---

## 11. What's Not In This Phase

- Notifications (ntfy, Telegram) — Phase 5
- Dashboard (`/afk:review` UI) — Phase 6
- Anomaly detection — Phase 4
- Session tracking (`session.js`) — Phase 7
- The deferred items resolved via CLI in Phase 3 do NOT re-execute the action. Claude must re-attempt the original request after the user resolves the queue.
