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
