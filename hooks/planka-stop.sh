#!/bin/bash
# Stop hook for planka-channel: drops a marker file the planka-channel server
# watches with fs.watch. The marker name is the board id; the server unlinks
# it after consuming. Each consumed marker resets the throttle gate.
#
# Registered per-agent in the agent's ~/<workdir>/.claude/settings.local.json:
#   { "hooks": { "Stop": [{ "matcher": "",
#       "hooks": [{ "type": "command", "command": "/app/hooks/planka-stop.sh" }] }] } }
#
# PLANKA_BOARD_ID must be exported in the agent's launch environment (it is —
# entrypoint.sh sources the agent's .env into the launch wrapper).

set -e
mkdir -p /tmp/planka-stop 2>/dev/null || true
if [[ -n "${PLANKA_BOARD_ID:-}" ]]; then
  : > "/tmp/planka-stop/${PLANKA_BOARD_ID}" 2>/dev/null || true
fi
exit 0
