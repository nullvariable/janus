#!/usr/bin/env bash
# nightly-restart.sh — recycle every janus container to:
#   1. pull the latest @anthropic-ai/claude-code (entrypoint runs npm i -g
#      claude-code@latest on each boot, see entrypoint.sh)
#   2. reset every agent's Claude Code context window (long-running sessions
#      drift toward the limit; canonical state lives on disk anyway —
#      memory files, Planka, vault — so dropping in-session memory is safe)
#   3. clear stale Docker Desktop WSL bind-mount cache (a known issue that
#      breaks `docker compose restart` cleanly; we use `down` + `up` instead)
#
# Designed to be called from a host crontab. Logs stdout+stderr to
# ~/.local/state/janus/nightly-restart.log so cron mail isn't required.
#
# Usage:
#   crontab -e
#   0 3 * * *  $HOME/projects/janus/scripts/nightly-restart.sh
#
# Override the compose-project location with JANUS_DIR if your checkout lives
# elsewhere, and JANUS_LOG_DIR for the log destination.
#
# Exits non-zero if the down or up command fails. The crontab line above
# will then leave a non-zero exit visible to cron's MTA / sentry / wherever
# you collect cron failures.

set -euo pipefail

JANUS_DIR="${JANUS_DIR:-$HOME/projects/janus}"
LOG_DIR="${JANUS_LOG_DIR:-$HOME/.local/state/janus}"
LOG_FILE="$LOG_DIR/nightly-restart.log"

mkdir -p "$LOG_DIR"

# Funnel everything to the log with a timestamped header.
exec >>"$LOG_FILE" 2>&1

echo
echo "=== nightly-restart $(date -Iseconds) ==="

if [[ ! -d "$JANUS_DIR" ]]; then
  echo "FATAL: $JANUS_DIR does not exist"
  exit 1
fi

cd "$JANUS_DIR"

# Snapshot which janus services are currently up so `up -d` brings up the
# same set (not all services in compose) — protects against e.g. cos-agent
# being intentionally stopped.
RUNNING_SERVICES=$(docker compose ps --status running --services | tr '\n' ' ')
if [[ -z "${RUNNING_SERVICES// }" ]]; then
  echo "no janus services running; nothing to do"
  exit 0
fi
echo "running services: $RUNNING_SERVICES"

echo "down..."
docker compose down

echo "up..."
# shellcheck disable=SC2086
docker compose up -d $RUNNING_SERVICES

# Wait briefly so the bun/MCP procs have time to come up before logging.
sleep 8

echo "post-restart container state:"
docker compose ps --format 'table {{.Service}}\t{{.Status}}'

echo "=== nightly-restart done $(date -Iseconds) ==="
