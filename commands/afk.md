---
name: afk
description: Toggle AFK mode on/off, set a duration, or check status
---

Run the AFK CLI with the user's argument. First ensure dependencies are installed:

```bash
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT}"
if [ ! -d "$PLUGIN_ROOT/node_modules/better-sqlite3" ]; then
  npm install --prefix "$PLUGIN_ROOT" --production 2>/dev/null
  node "$PLUGIN_ROOT/scripts/setup.js" 2>/dev/null
fi
node "$PLUGIN_ROOT/scripts/afk-cli.js" <arg>
```

Where `<arg>` is exactly what the user typed after `/afk` (e.g. `on`, `off`, `30m`, `status`).
If the user typed `/afk` with no argument, use `status`.

Read the output and present it clearly to the user.

If the output lists pending deferred items, ask the user to approve or deny each one.
For each decision, run: `node "$PLUGIN_ROOT/scripts/afk-cli.js" resolve <id> allow|deny`
Confirm each resolution to the user as you go.
