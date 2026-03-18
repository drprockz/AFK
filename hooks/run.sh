#!/bin/bash
# Run any AFK script with auto-bootstrap.
# Usage: run.sh <script-name> [args...]
# Example: run.sh afk-cli.js status
PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ ! -d "$PLUGIN_ROOT/node_modules/better-sqlite3" ]; then
  npm install --prefix "$PLUGIN_ROOT" --production >/dev/null 2>&1 || true
  node "$PLUGIN_ROOT/scripts/setup.js" >/dev/null 2>&1 || true
fi

# Validate script name: must be a plain filename (no path separators or dots leading to traversal)
SCRIPT_NAME="$1"
if [ -z "$SCRIPT_NAME" ] || echo "$SCRIPT_NAME" | grep -q '[/\\]' || case "$SCRIPT_NAME" in .*) true;; *) false;; esac ; then
  echo "afk: invalid script name: $SCRIPT_NAME" >&2
  exit 1
fi

SCRIPT_PATH="$PLUGIN_ROOT/scripts/$SCRIPT_NAME"
if [ ! -f "$SCRIPT_PATH" ]; then
  echo "afk: script not found: $SCRIPT_NAME" >&2
  exit 1
fi

exec node "$SCRIPT_PATH" "${@:2}"
