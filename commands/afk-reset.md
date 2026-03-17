---
name: afk:reset
description: Clear all AFK decision history and start fresh. Preserves rules and config.
---

```bash
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT}"
if [ ! -d "$PLUGIN_ROOT/node_modules/better-sqlite3" ]; then
  npm install --prefix "$PLUGIN_ROOT" --production 2>/dev/null
  node "$PLUGIN_ROOT/scripts/setup.js" 2>/dev/null
fi
node "$PLUGIN_ROOT/scripts/afk-reset-cli.js"
```

This command requires confirmation. Read the output and report back to the user.
Warn the user clearly before proceeding — this deletes all decisions, sessions, deferred items, and baselines.
