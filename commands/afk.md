---
name: afk
description: Toggle AFK mode on/off, set a duration, or check status
---

The AFK state file lives at `~/.claude/afk/state.json`. Read and write it directly — no bash needed.

## Handling the user's argument

Parse what follows `/afk`. It will be one of: `on`, `off`, `status`, a duration like `30m` or `2h`, or empty (treat as `status`).

### `/afk status` (or no argument)

1. Read `~/.claude/afk/state.json`
2. Report:
   - Whether AFK mode is on or off
   - If on: since when, and until when (if timed)
   - If `afk_until` is in the past, AFK has expired — report as OFF
   - Show `digest` array length as "actions logged this session"

### `/afk on`

1. Read `~/.claude/afk/state.json`
2. Write back with these changes:
   - `"afk": true`
   - `"afk_since": <current unix ms timestamp>`
   - `"afk_until": null`
   - Keep all other fields unchanged
3. Confirm: "AFK mode ON. Safe actions will be auto-approved, destructive actions deferred."

### `/afk off`

1. Read `~/.claude/afk/state.json`
2. Check the `digest` array — summarize what happened while AFK:
   - Count actions by decision type (allow, deny, defer)
   - List any deferred items
3. Write back with:
   - `"afk": false`
   - `"afk_since": null`
   - `"afk_until": null`
   - `"digest": []` (clear after showing)
   - Keep all other fields unchanged
4. If there were deferred actions, remind the user: "Run /afk:review to process deferred items."

### `/afk <duration>` (e.g., `30m`, `1h`, `2h30m`)

1. Parse the duration into minutes:
   - `30m` → 30 minutes
   - `1h` → 60 minutes
   - `2h30m` → 150 minutes
2. Read `~/.claude/afk/state.json`
3. Write back with:
   - `"afk": true`
   - `"afk_since": <current unix ms timestamp>`
   - `"afk_until": <current unix ms + duration in ms>`
   - Keep all other fields unchanged
4. Confirm: "AFK mode ON for <duration>. Will auto-return at <time>."
