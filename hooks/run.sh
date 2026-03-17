#!/bin/bash
# Run any AFK script with auto-bootstrap.
# Usage: run.sh <script-name> [args...]
# Example: run.sh afk-cli.js status
PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ ! -d "$PLUGIN_ROOT/node_modules/better-sqlite3" ]; then
  npm install --prefix "$PLUGIN_ROOT" --production 2>/dev/null
  node "$PLUGIN_ROOT/scripts/setup.js" 2>/dev/null
fi

node "$PLUGIN_ROOT/scripts/$1" "${@:2}"
