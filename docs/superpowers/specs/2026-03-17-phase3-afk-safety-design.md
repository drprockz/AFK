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
4. If commit exits 1 with "nothing to commit" message → working tree clean → return `{ snapshotted: false, commit: null }`. Not an error.
5. On success → parse commit hash from stdout → return `{ snapshotted: true, commit: '<hash>' }`.
6. Any other failure (git not installed, permission error) → `process.stderr.write` the error → return `{ snapshotted: false, commit: null }`. Never throws. Never blocks.

### Constraints

- All git commands run with `{ cwd }` option via `child_process.spawn` or `execFile` (not `exec` to avoid shell injection).
- Uses Node.js built-in `node:child_process` — no new dependencies.
- Snapshot result is NOT logged to the `decisions` table — it is included in the `reason` field of the deferred log entry.
- Counts against the deadline budget in `chain.js` (async, awaited before queue insert).

---

## 2. Deferral Queue — `src/store/queue.js`

### Purpose

CRUD operations over the existing `deferred` table. Used by chain.js (enqueue) and afk-cli.js (list, resolve).

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
- `enqueueDeferred` stores `JSON.stringify(input)` (raw, not sanitized — reviewers need full context).
- `resolveItem` sets `reviewed=1`, `final`, `review_ts=Date.now()`.
- No cascade deletes. Reviewed items remain in the table for audit.

---

## 3. Chain Wiring — `src/engine/chain.js` (modification)

The existing Phase 3 comment in step 3 (destructive AFK-ON path) is replaced with:

```
AFK ON + destructive:
  1. await snapshot(cwd, destructive.reason)
     → snapshotted flag included in reason string for logDecision
  2. decisionsId = logDecision(..., decision='defer', source='auto_defer',
       reason=`Destructive: ${reason}. Snapshot: ${commit ?? 'none'}`)
  3. enqueueDeferred({ decisionsId, sessionId, tool, input, command, path })
  4. return { behavior: 'ask', reason: `Destructive action deferred: ${reason}` }
```

### Deadline guard for snapshot

Before calling `snapshot()`, check deadline budget:

```js
const remaining = deadline - Date.now()
if (remaining <= 3000) {
  // Not enough time to snapshot safely — skip it, still defer
  // log with reason: 'Snapshot skipped: deadline too close'
} else {
  await snapshot(cwd, destructive.reason)
}
```

The 3000ms buffer (vs 2000ms for notifications) accounts for git operations being slower than network calls.

---

## 4. Idle Detector — `src/afk/detector.js`

### Purpose

Auto-enable AFK mode when Claude has been idle for longer than `auto_afk_minutes`. Called at chain entry on every hook invocation.

### Interface

```js
/**
 * Checks if the user has been idle long enough to auto-enable AFK.
 * Updates last_request_ts unconditionally on every call.
 * @returns {void}
 */
export function checkAndAutoAfk()
```

### Behavior

1. Read state file.
2. If `auto_afk_minutes === 0` → skip (auto-AFK disabled).
3. If `state.afk === true` → skip (already in AFK mode, don't re-trigger).
4. If `state.last_request_ts` exists AND `Date.now() - last_request_ts > auto_afk_minutes * 60 * 1000`:
   - Call `setAfk(true)` (no duration — stays on until user calls `/afk off`)
   - `process.stderr.write(`afk: auto-AFK enabled after ${elapsed} minutes idle\n`)`
5. Write `last_request_ts = Date.now()` to state file (always, whether or not AFK was triggered).

### Chain integration

Called at the very start of `chain()`, before `isAfk()` is evaluated:

```js
export async function chain(request, deadline) {
  if (Date.now() >= deadline) return { behavior: 'ask', reason: 'deadline expired' }

  checkAndAutoAfk()           // ← new: may flip afkOn to true
  const afkOn = isAfk()       // ← existing: reads current state
  ...
}
```

### State file additions

Two new fields added to `defaultState()` in `state.js`:

```json
{
  "last_request_ts": null,
  "auto_afk_minutes": 15
}
```

`auto_afk_minutes` defaults to 15. Reads from `config.json`'s `afk.autoAfkMinutes` on first setup (setup.js already writes this value).

---

## 5. Session Digest — `src/afk/digest.js`

### Purpose

Pure formatting function — turns the digest array from state into a human-readable narrative string. No I/O.

### Interface

```js
/**
 * Builds a human-readable AFK session digest string.
 * Pure function — no I/O, no DB access.
 * @param {object[]} entries — digest entries from state.digest
 * @param {number} pendingCount — number of unreviewed deferred items
 * @returns {string} formatted digest text
 */
export function buildDigest(entries, pendingCount)
```

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

### Grouping logic

- Entries with `decision='allow'` are grouped by tool. Within each tool group, unique commands/paths are listed (max 3, then "and N more").
- Entries with `decision='defer'` are listed individually with a `[N]` index — these map to the deferred queue IDs shown by `afk-cli.js off`.
- If `entries` is empty and `pendingCount === 0` → return `"No activity during AFK session."`.
- If `entries` is empty but `pendingCount > 0` → show only the deferred section.

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
node scripts/afk-cli.js on              — enable AFK mode
node scripts/afk-cli.js off             — disable AFK, print digest + pending queue
node scripts/afk-cli.js status          — print current AFK state + queue count
node scripts/afk-cli.js 30m            — enable AFK for 30 minutes
node scripts/afk-cli.js 2h             — enable AFK for 2 hours
node scripts/afk-cli.js resolve <id> <allow|deny>  — resolve a deferred item
```

### Duration parsing

`parseDuration(str)` → minutes:
- `30m` → 30
- `2h` → 120
- `1h30m` → 90
- Invalid → null (treated as `on` with no duration)

### `off` subcommand output

```
AFK mode: OFF

[digest text from buildDigest()]

Pending deferred actions (3):
  [id=4] Bash: rm -rf dist/           ts: 2026-03-17 14:23
  [id=5] Bash: DROP TABLE logs        ts: 2026-03-17 14:31
  [id=6] Write: /projects/app/.env    ts: 2026-03-17 14:45

To resolve: node scripts/afk-cli.js resolve <id> allow|deny
```

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
- Module errors → `process.stderr.write`, exit 0. Never crash — Claude reads stdout.
- Always exits 0.

---

## 7. Slash Command — `commands/afk.md`

```markdown
---
name: afk
description: Toggle AFK mode on/off, set a duration, or check status
---

Invoke AFK mode management by running the CLI script with the user's argument.

Run: `node /path/to/scripts/afk-cli.js <arg>`

Where `<arg>` is exactly what the user typed after `/afk` (e.g. `on`, `off`, `30m`, `status`).
If the user typed `/afk` with no argument, use `status`.

Read the output and present it clearly to the user.

If the output lists pending deferred items, ask the user to approve or deny each one.
For each decision, run: `node /path/to/scripts/afk-cli.js resolve <id> allow|deny`
Confirm each resolution to the user as you go.
```

The path in the slash command is `${pluginDir}/scripts/afk-cli.js` — but since slash commands run in Claude's context (not as a plugin hook), use the absolute path from `plugin.json`'s `pluginDir` variable, or instruct Claude to resolve it relative to the project root.

**Note:** The actual path resolution strategy depends on how Claude Code injects `pluginDir` into slash command prompts. For local dev, the path is hardcoded in `.claude/settings.json` equivalent. For marketplace installs, `${pluginDir}` is injected by Claude Code.

---

## 8. New Files Summary

| File | Type | Purpose |
|---|---|---|
| `src/safety/snapshot.js` | new | git checkpoint before defer |
| `src/store/queue.js` | new | deferral queue CRUD |
| `src/afk/detector.js` | new | request-gap auto-AFK |
| `src/afk/digest.js` | new | pure digest formatter |
| `scripts/afk-cli.js` | new | CLI for slash command |
| `commands/afk.md` | new | `/afk` slash command prompt |
| `src/engine/chain.js` | modify | wire snapshot+queue into step 3 AFK-ON path, add `checkAndAutoAfk()` call |
| `src/afk/state.js` | modify | add `last_request_ts` and `auto_afk_minutes` to `defaultState()` |
| `test/snapshot.test.js` | new | snapshot happy path + non-git-repo case |
| `test/queue.test.js` | new | enqueue, getPending, resolve |
| `test/detector.test.js` | new | auto-AFK trigger + no-trigger cases |
| `test/digest.test.js` | new | digest formatting, empty case |
| `test/afk-cli.test.js` | new | CLI subcommand output |
| `test/chain.test.js` | modify | add AFK-ON destructive → snapshot+queue tests |

---

## 9. What's Not In This Phase

- Notifications (ntfy, Telegram) — Phase 5
- Dashboard (`/afk:review` UI) — Phase 6
- Anomaly detection — Phase 4
- Session tracking (`session.js`) — Phase 7
- The deferred items resolved via CLI in Phase 3 do NOT re-execute the action. Claude must re-attempt the original request after the user resolves the queue.
