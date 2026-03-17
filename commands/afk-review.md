---
name: afk:review
description: Open the AFK web dashboard in your browser (starts server if needed).
---

Start the dashboard server and open it in the browser:

```bash
SCRIPT="${PLUGIN_DIR}/scripts/afk-review-cli.js"
if [ -z "$PLUGIN_DIR" ] || [ ! -f "$SCRIPT" ]; then
  SCRIPT="$(git rev-parse --show-toplevel 2>/dev/null)/scripts/afk-review-cli.js"
fi
node "$SCRIPT"
```

Read the output and report the URL to the user.
The dashboard shows decision history, deferred queue, patterns, rules, and session digest.
