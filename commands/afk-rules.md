---
name: afk:rules
description: List, add, or remove static approval rules.
---

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/afk-rules-cli.js" <args>
```

Where `<args>` is what the user typed after `/afk:rules` (empty = list, `add tool=Bash pattern="npm *" action=allow`, `remove <id>`, `project`).

Read the output and present it clearly.
