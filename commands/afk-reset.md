---
name: afk:reset
description: Clear all AFK decision history and start fresh. Preserves rules and config.
---

```bash
SCRIPT="${PLUGIN_DIR}/scripts/afk-reset-cli.js"
if [ -z "$PLUGIN_DIR" ] || [ ! -f "$SCRIPT" ]; then
  SCRIPT="$(git rev-parse --show-toplevel 2>/dev/null)/scripts/afk-reset-cli.js"
fi
node "$SCRIPT"
```

This command requires confirmation. Read the output and report back to the user.
Warn the user clearly before proceeding — this deletes all decisions, sessions, deferred items, and baselines.
