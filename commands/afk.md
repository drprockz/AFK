---
name: afk
description: Toggle AFK mode on/off, set a duration, or check status
---

Run the AFK CLI with the user's argument:

```bash
"${CLAUDE_PLUGIN_ROOT}/hooks/run.sh" afk-cli.js <arg>
```

Where `<arg>` is exactly what the user typed after `/afk` (e.g. `on`, `off`, `30m`, `status`).
If the user typed `/afk` with no argument, use `status`.

Read the output and present it clearly to the user.

If the output lists pending deferred items, ask the user to approve or deny each one.
For each decision, run: `"${CLAUDE_PLUGIN_ROOT}/hooks/run.sh" afk-cli.js resolve <id> allow|deny`
Confirm each resolution to the user as you go.
