#!/usr/bin/env bash
# Idempotently provision one GlitchTip (or Sentry) project per janus agent
# and write the resulting DSNs to ../.env as GLITCHTIP_DSN_<AGENT>.
#
# Required env (in ../.env or the calling shell):
#   GLITCHTIP_AUTH_TOKEN  Personal auth token with project:write
#   GLITCHTIP_HOST        e.g. https://glitchtip.example.com
#   GLITCHTIP_ORG_SLUG    org that owns the projects
#   GLITCHTIP_TEAM_SLUG   team that owns the projects
#
# Optional:
#   JANUS_AGENTS          space-separated agent list (default: health geordi
#                         marketing links). Override to match your fleet.
#
# Re-running is safe: existing janus-<agent> projects are reused, DSN lines
# in .env are replaced rather than duplicated.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"

if [[ -f "$ENV_FILE" ]]; then
  set -a; source "$ENV_FILE"; set +a
fi

: "${GLITCHTIP_AUTH_TOKEN:?Set GLITCHTIP_AUTH_TOKEN in $ENV_FILE}"
: "${GLITCHTIP_HOST:?Set GLITCHTIP_HOST in $ENV_FILE (e.g. https://glitchtip.example.com)}"
: "${GLITCHTIP_ORG_SLUG:?Set GLITCHTIP_ORG_SLUG in $ENV_FILE}"
: "${GLITCHTIP_TEAM_SLUG:?Set GLITCHTIP_TEAM_SLUG in $ENV_FILE}"
ORG="${GLITCHTIP_ORG_SLUG}"
TEAM="${GLITCHTIP_TEAM_SLUG}"
if [[ -n "${JANUS_AGENTS:-}" ]]; then
  read -ra AGENTS <<< "$JANUS_AGENTS"
else
  AGENTS=(health geordi marketing links)
fi

api() {
  local method="$1" path="$2"
  shift 2
  curl -sS -m 15 -X "$method" \
    -H "Authorization: Bearer $GLITCHTIP_AUTH_TOKEN" \
    -H "Content-Type: application/json" \
    "$@" \
    "${GLITCHTIP_HOST}${path}"
}

upsert_env_var() {
  local key="$1" value="$2"
  if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
    # Use a temp file to avoid sed in-place portability gotchas
    awk -v k="$key" -v v="$value" 'BEGIN{FS=OFS="="} $1==k{$0=k"="v} {print}' "$ENV_FILE" > "$ENV_FILE.tmp"
    mv "$ENV_FILE.tmp" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

ensure_project() {
  local agent="$1"
  local slug="janus-${agent}"
  local existing
  existing=$(api GET "/api/0/projects/${ORG}/${slug}/" || true)
  if echo "$existing" | grep -q "\"slug\""; then
    echo "[bootstrap] project ${slug} already exists" >&2
  else
    echo "[bootstrap] creating project ${slug}..." >&2
    local created
    created=$(api POST "/api/0/teams/${ORG}/${TEAM}/projects/" \
      --data "{\"name\":\"${slug}\",\"slug\":\"${slug}\",\"platform\":\"javascript-node\"}")
    if ! echo "$created" | grep -q "\"slug\""; then
      echo "[bootstrap] FAILED to create ${slug}: $created" >&2
      return 1
    fi
  fi

  # Fetch DSN
  local keys dsn
  keys=$(api GET "/api/0/projects/${ORG}/${slug}/keys/")
  dsn=$(echo "$keys" | python3 -c '
import json, sys
data = json.load(sys.stdin)
if not data:
    sys.exit("no keys")
print(data[0]["dsn"]["public"])
')
  echo "$dsn"
}

echo "[bootstrap] org=${ORG} team=${TEAM} host=${GLITCHTIP_HOST}" >&2
for agent in "${AGENTS[@]}"; do
  dsn=$(ensure_project "$agent")
  var="GLITCHTIP_DSN_${agent^^}"
  upsert_env_var "$var" "$dsn"
  echo "[bootstrap] ${var}=${dsn}" >&2
done

echo "[bootstrap] done. DSNs written to $ENV_FILE" >&2
