---
name: afk:stats
description: Show today's AFK decision summary in the terminal.
---

```bash
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT}"
if [ ! -d "$PLUGIN_ROOT/node_modules/better-sqlite3" ]; then
  npm install --prefix "$PLUGIN_ROOT" --production 2>/dev/null
  node "$PLUGIN_ROOT/scripts/setup.js" 2>/dev/null
fi
node "$PLUGIN_ROOT/scripts/afk-stats-cli.js"
```

Read the output and present it clearly to the user.
