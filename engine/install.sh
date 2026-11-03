#!/bin/sh
# Build, sign, self-check and wire the plugin into WorkBuddy's MCP config.
set -eu
cd "$(dirname "$0")"

./build.sh

echo
echo "== self check =="
./bin/cu selfcheck

CONFIG="$HOME/.workbuddy/mcp.json"
if [ -f "$CONFIG" ] && grep -q '"computer-use"' "$CONFIG"; then
  echo
  echo "WorkBuddy already points at this plugin ($CONFIG)."
else
  echo
  echo "Add this to $CONFIG under mcpServers:"
  echo '  "computer-use": {'
  echo "    \"command\": \"/opt/homebrew/bin/python3\","
  echo "    \"args\": [\"$(pwd)/mcp/server.py\"]"
  echo '  }'
fi

echo
echo "Restart WorkBuddy (or reconnect MCP) and open a new chat for the tools to appear."
