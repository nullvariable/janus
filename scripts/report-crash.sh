#!/usr/bin/env bash
# report_crash <agent_name> <exit_code> <tail_text>
#
# Sends a synthetic Sentry event to the agent's Sentry/GlitchTip DSN, so a
# tmux pane crashing inside the container shows up in your error tracker
# alongside the other Sentry events from the agent's own runtime.
#
# Setup (all optional — if no DSN is configured, this is a no-op):
#   GLITCHTIP_DSN_<AGENT>  — per-agent DSN, e.g. GLITCHTIP_DSN_HEALTH=https://...
#   GLITCHTIP_INGEST       — override the ingest base URL (default: derived
#                            from the DSN's host). Useful when the container
#                            reaches the tracker via a different hostname
#                            than the DSN's public URL (e.g. an internal
#                            Docker network alias). Format: scheme://host[:port]
#
# Idempotent + best-effort: any failure is swallowed (we never want to block
# a respawn on a reporting hiccup).

# Resolve DSN env var (e.g. GLITCHTIP_DSN_HEALTH).
report_crash() {
  local agent="$1" exit_code="$2" tail_text="$3"
  local dsn_var
  dsn_var="GLITCHTIP_DSN_$(echo "$agent" | tr '[:lower:]' '[:upper:]')"
  local dsn="${!dsn_var:-}"
  if [[ -z "$dsn" ]]; then
    return 0
  fi

  # DSN format: https://<key>@<host>/<project_id>
  local key dsn_scheme dsn_host project
  key=$(printf '%s' "$dsn" | sed -nE 's|^https?://([^@]+)@.*$|\1|p')
  dsn_scheme=$(printf '%s' "$dsn" | sed -nE 's|^(https?)://.*$|\1|p')
  dsn_host=$(printf '%s' "$dsn" | sed -nE 's|^https?://[^@]+@([^/]+)/.*$|\1|p')
  project=$(printf '%s' "$dsn" | sed -nE 's|^.*/([0-9]+)$|\1|p')
  if [[ -z "$key" || -z "$project" ]]; then
    echo "[report-crash] could not parse DSN for $agent" >&2
    return 0
  fi

  # By default, ingest at the same host as the DSN. Override GLITCHTIP_INGEST
  # when the container reaches the tracker via a different hostname than the
  # DSN's public URL (e.g. an internal Docker network alias like
  # http://glitchtip:8000) — keeps the project id + key from the DSN.
  local ingest="${GLITCHTIP_INGEST:-${dsn_scheme}://${dsn_host}}"
  local url="${ingest}/api/${project}/store/"

  # Sentry protocol requires event_id (UUID4 hex, no dashes) and timestamp.
  local event_id timestamp
  if [[ -r /proc/sys/kernel/random/uuid ]]; then
    event_id=$(tr -d '-' < /proc/sys/kernel/random/uuid)
  else
    event_id=$(od -An -N16 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n')
  fi
  timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  local payload
  if command -v jq >/dev/null 2>&1; then
    payload=$(jq -nc \
      --arg event_id "$event_id" \
      --arg timestamp "$timestamp" \
      --arg msg "Pane '${agent}' died (exit=${exit_code})" \
      --arg agent "$agent" \
      --arg exit "$exit_code" \
      --arg tail "$tail_text" \
      '{event_id:$event_id, timestamp:$timestamp, message:$msg, level:"error", platform:"other",
        tags:{agent:$agent, service:"entrypoint", exit_code:$exit},
        extra:{tail:$tail}}')
  else
    # Minimal escape: collapse newlines, drop quotes/backslashes from tail.
    local safe_tail="${tail_text//\"/}"
    safe_tail="${safe_tail//\\/}"
    safe_tail="${safe_tail//$'\n'/ | }"
    payload="{\"event_id\":\"${event_id}\",\"timestamp\":\"${timestamp}\",\"message\":\"Pane '${agent}' died (exit=${exit_code})\",\"level\":\"error\",\"platform\":\"other\",\"tags\":{\"agent\":\"${agent}\",\"service\":\"entrypoint\",\"exit_code\":\"${exit_code}\"},\"extra\":{\"tail\":\"${safe_tail}\"}}"
  fi

  curl -sS -m 5 -X POST "$url" \
    -H "Content-Type: application/json" \
    -H "X-Sentry-Auth: Sentry sentry_version=7, sentry_key=${key}, sentry_client=janus-entrypoint/1.0" \
    -d "$payload" >/dev/null 2>&1 || true
}
