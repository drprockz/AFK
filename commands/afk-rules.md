---
name: afk:rules
description: List, add, or remove static approval rules.
---

```bash
SCRIPT="${PLUGIN_DIR}/scripts/afk-rules-cli.js"
if [ -z "$PLUGIN_DIR" ] || [ ! -f "$SCRIPT" ]; then
  SCRIPT="$(git rev-parse --show-toplevel 2>/dev/null)/scripts/afk-rules-cli.js"
fi
node "$SCRIPT" <args>
```

Where `<args>` is what the user typed after `/afk:rules` (empty = list, `add tool=Bash pattern="npm *" action=allow`, `remove <id>`, `project`).

Read the output and present it clearly.
