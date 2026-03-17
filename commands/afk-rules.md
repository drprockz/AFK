---
name: afk:rules
description: List, add, or remove static approval rules.
---

```bash
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT}"
if [ ! -d "$PLUGIN_ROOT/node_modules/better-sqlite3" ]; then
  npm install --prefix "$PLUGIN_ROOT" --production 2>/dev/null
  node "$PLUGIN_ROOT/scripts/setup.js" 2>/dev/null
fi
node "$PLUGIN_ROOT/scripts/afk-rules-cli.js" <args>
```

Where `<args>` is what the user typed after `/afk:rules` (empty = list, `add tool=Bash pattern="npm *" action=allow`, `remove <id>`, `project`).

Read the output and present it clearly.
