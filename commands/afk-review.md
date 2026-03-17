---
name: afk:review
description: Open the AFK web dashboard in your browser (starts server if needed).
---

Start the dashboard server and open it in the browser:

```bash
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT}"
if [ ! -d "$PLUGIN_ROOT/node_modules/better-sqlite3" ]; then
  npm install --prefix "$PLUGIN_ROOT" --production 2>/dev/null
  node "$PLUGIN_ROOT/scripts/setup.js" 2>/dev/null
fi
node "$PLUGIN_ROOT/scripts/afk-review-cli.js"
```

Read the output and report the URL to the user.
The dashboard shows decision history, deferred queue, patterns, rules, and session digest.
