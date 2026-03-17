---
name: afk:stats
description: Show today's AFK decision summary in the terminal.
---

```bash
SCRIPT="${PLUGIN_DIR}/scripts/afk-stats-cli.js"
if [ -z "$PLUGIN_DIR" ] || [ ! -f "$SCRIPT" ]; then
  SCRIPT="$(git rev-parse --show-toplevel 2>/dev/null)/scripts/afk-stats-cli.js"
fi
node "$SCRIPT"
```

Read the output and present it clearly to the user.
