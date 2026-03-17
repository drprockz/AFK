---
name: afk:reset
description: Clear all AFK decision history and start fresh. Preserves rules and config.
---

```bash
"${CLAUDE_PLUGIN_ROOT}/hooks/run.sh" afk-reset-cli.js
```

This command requires confirmation. Read the output and report back to the user.
Warn the user clearly before proceeding — this deletes all decisions, sessions, deferred items, and baselines.
