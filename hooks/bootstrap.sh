#!/bin/bash
# Bootstrap: ensure dependencies are installed before running the hook.
# Claude Code doesn't auto-run npm install for plugins.
PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ ! -d "$PLUGIN_ROOT/node_modules/better-sqlite3" ]; then
  npm install --prefix "$PLUGIN_ROOT" --production >/dev/null 2>&1 || true
  node "$PLUGIN_ROOT/scripts/setup.js" >/dev/null 2>&1 || true
fi

exec node "$PLUGIN_ROOT/src/hook.js"
