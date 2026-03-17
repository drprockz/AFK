---
name: afk:review
description: Open the AFK web dashboard in your browser (starts server if needed).
---

Start the dashboard server and open it in the browser:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/afk-review-cli.js"
```

Read the output and report the URL to the user.
The dashboard shows decision history, deferred queue, patterns, rules, and session digest.
