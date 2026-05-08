#!/bin/bash
# Stop hook for planka-channel: drops a marker file the planka-channel server
# watches with fs.watch. The marker name is the agent's PLANKA_INSTANCE_NAME
# (a short agent label, or the board id for single-board agents); the server
# unlinks it after consuming. Each consumed marker resets the throttle gate.
#
# Registered per-agent in the agent's ~/<workdir>/.claude/settings.local.json:
#   { "hooks": { "Stop": [{ "matcher": "",
#       "hooks": [{ "type": "command", "command": "/app/hooks/planka-stop.sh" }] }] } }
#
# PLANKA_INSTANCE_NAME (or PLANKA_BOARD_ID for back-compat single-board) must
# be exported in the agent's launch environment — entrypoint.sh sources the
# agent's .env into the launch wrapper.

set -e
mkdir -p /tmp/planka-stop 2>/dev/null || true
marker="${PLANKA_INSTANCE_NAME:-${PLANKA_BOARD_ID:-}}"
if [[ -n "$marker" ]]; then
  : > "/tmp/planka-stop/${marker}" 2>/dev/null || true
fi
exit 0
