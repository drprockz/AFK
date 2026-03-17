---
name: afk:reset
description: Clear all AFK decision history and start fresh. Preserves rules and config.
---

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/afk-reset-cli.js"
```

This command requires confirmation. Read the output and report back to the user.
Warn the user clearly before proceeding — this deletes all decisions, sessions, deferred items, and baselines.
