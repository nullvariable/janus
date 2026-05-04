#!/bin/bash
# post_llm_call shell hook for Hermes — backstops mattermost replies the
# same way mattermost-autopost.sh does for Claude Code.
#
# Wires up by being referenced from agents/<name>/config.yaml under:
#   hooks:
#     post_llm_call:
#       - command: "/app/hooks/hermes-mattermost-autopost.sh"
#
# Behavior:
#   - If the inbound user message carried <channel source="mattermost"
#     post_id="..." channel_id="...">, AND the agent didn't call any
#     mcp_mattermost_{post,reply,react} tool during the turn, AND the
#     assistant response is non-empty, post the response to the channel.
#   - Otherwise stay silent (the agent already handled the channel side, or
#     this isn't a Mattermost-driven turn).
#   - Always exits 0; never blocks.
#
# Mirrors the gating shape of hooks/mattermost-autopost.sh (the CC sibling)
# but reads session state from `hermes sessions export` instead of the CC
# transcript JSONL on disk.
set -euo pipefail

# Only meaningful inside the janus container.
if [[ ! -d /app/agents ]]; then
  exit 0
fi

LOG_FILE="/home/node/.claude/autopost.log"
LOCK_DIR="/tmp/autopost-locks"
mkdir -p "$LOCK_DIR"
find "$LOCK_DIR" -maxdepth 1 -type f -mmin +10 -delete 2>/dev/null || true

log() {
  mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || return 0
  echo "[$(date -Iseconds)] hermes agent=${AGENT:-?} session=${SESSION_ID:-?} $1" >> "$LOG_FILE" 2>/dev/null || true
}

# --- Read hook input ---
INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('session_id',''))" 2>/dev/null)
LAST_MSG=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('assistant_response',''))" 2>/dev/null)
CWD=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('cwd',''))" 2>/dev/null)

AGENT=$(basename "${HERMES_AGENT_NAME:-${CWD:-}}")
[[ -z "$AGENT" || "$AGENT" == "/" ]] && AGENT=$(basename "$(pwd)")

# --- Mattermost creds: prefer agent's .mcp.json (CC), fall back to
# config.yaml's mcp_servers.mattermost.env block (Hermes). ---
MCP_JSON="/app/agents/$AGENT/.mcp.json"
HERMES_YAML="/app/agents/$AGENT/config.yaml"

read_mm() {
  local key="$1"
  if [[ -f "$MCP_JSON" ]]; then
    python3 -c "
import json
d=json.load(open('$MCP_JSON'))
print(d.get('mcpServers',{}).get('mattermost',{}).get('env',{}).get('$key',''))
" 2>/dev/null
    return
  fi
  if [[ -f "$HERMES_YAML" ]]; then
    # Pull the value out of the mattermost env block in config.yaml. Schema is
    # stable and shallow, so a small regex walker is enough — keeps the hook
    # PyYAML-free.
    KEY="$key" python3 << 'PYEOF' < "$HERMES_YAML" 2>/dev/null
import os, re, sys
key = os.environ["KEY"]
text = sys.stdin.read()
# Find the mattermost env block under mcp_servers.
m = re.search(r'(?ms)^mcp_servers:\s*\n(?:.*?\n)*?\s+mattermost:\s*\n((?:[ \t].*\n?)+)', text)
if not m:
    sys.exit(0)
block = m.group(1)
m2 = re.search(rf'(?m)^\s+{re.escape(key)}:\s*"?([^"\n]+)"?\s*$', block)
if m2:
    print(m2.group(1).strip())
PYEOF
    return
  fi
}

MM_URL=$(read_mm MATTERMOST_URL)
MM_TOKEN=$(read_mm MATTERMOST_BOT_TOKEN)
MM_CHANNEL=$(read_mm MATTERMOST_CHANNEL_ID)

if [[ -z "$MM_URL" ]]; then
  log "skip-no-mattermost-config"
  exit 0
fi

# Signal the typing keepalive to stop (mattermost-channel server fs.watches this).
TYPING_DIR=/tmp/mattermost-typing
if [[ -n "$MM_CHANNEL" ]]; then
  mkdir -p "$TYPING_DIR" 2>/dev/null || true
  : > "$TYPING_DIR/typing-stop-$MM_CHANNEL" 2>/dev/null || true
fi

# Empty assistant response → nothing to forward.
if [[ -z "${LAST_MSG// /}" ]]; then
  log "skip-empty"
  exit 0
fi

if [[ -z "$SESSION_ID" ]]; then
  log "skip-no-session-id"
  exit 0
fi

# --- Pull the session JSONL via the hermes CLI ---
SESSION_JSONL=$(hermes sessions export - --session-id "$SESSION_ID" 2>/dev/null) || true
if [[ -z "$SESSION_JSONL" ]]; then
  log "skip-session-export-empty session=$SESSION_ID"
  exit 0
fi

# Detect whether the agent already handled the channel side this turn.
# Any mcp_mattermost_* tool call is "handled" — covers post, reply, react.
if echo "$SESSION_JSONL" | grep -q 'mcp_mattermost_'; then
  log "skip-tool-called"
  exit 0
fi

# Resolve channel_id + post_id from the most recent user message that
# carries a <channel source="mattermost" ...> wrapper. If there isn't one,
# this turn was triggered some other way (terminal, hermes cron, etc.)
# — fall back to the agent's default channel.
TURN_CHANNEL=$(echo "$SESSION_JSONL" | python3 << 'PYEOF' 2>/dev/null
import json, re, sys
last = None
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        rec = json.loads(line)
    except Exception:
        continue
    role = rec.get("role") or rec.get("type")
    if role != "user":
        continue
    content = rec.get("content")
    if isinstance(content, list):
        for c in content:
            if isinstance(c, dict) and isinstance(c.get("text"), str):
                last = c["text"]
                break
    elif isinstance(content, str):
        last = content
if last:
    m = re.search(r'<channel source="mattermost"[^>]*?channel_id="([^"]+)"', last)
    if m:
        print(m.group(1))
PYEOF
)
TURN_POST_ID=$(echo "$SESSION_JSONL" | python3 << 'PYEOF' 2>/dev/null
import json, re, sys
last = None
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        rec = json.loads(line)
    except Exception:
        continue
    role = rec.get("role") or rec.get("type")
    if role != "user":
        continue
    content = rec.get("content")
    if isinstance(content, list):
        for c in content:
            if isinstance(c, dict) and isinstance(c.get("text"), str):
                last = c["text"]
                break
    elif isinstance(content, str):
        last = content
if last:
    m = re.search(r'<channel source="mattermost"[^>]*?post_id="([^"]+)"', last)
    if m:
        print(m.group(1))
PYEOF
)

POST_TO="${TURN_CHANNEL:-$MM_CHANNEL}"
SOURCE_LABEL="mattermost"
if [[ -z "$TURN_CHANNEL" ]]; then
  SOURCE_LABEL="non-mm-turn"
  # If the turn wasn't from a Mattermost wrapper, don't autopost — that's
  # a terminal/cron turn and the agent's silence is intentional.
  log "skip-not-mm-turn"
  exit 0
fi

# Idempotency: don't re-post the same content.
MSG_HASH=$(echo -n "$SESSION_ID:$LAST_MSG" | sha256sum | cut -c1-16)
if [[ -f "$LOCK_DIR/$MSG_HASH" ]]; then
  log "skip-duplicate hash=$MSG_HASH"
  exit 0
fi
touch "$LOCK_DIR/$MSG_HASH"

JSON_BODY=$(python3 -c "import json,sys; print(json.dumps(sys.stdin.read()))" <<< "$LAST_MSG")
HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' \
  -X POST "$MM_URL/api/v4/posts" \
  -H "Authorization: Bearer $MM_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"channel_id\": \"$POST_TO\", \"message\": $JSON_BODY}" 2>/dev/null || echo "000")

if [[ "$HTTP_CODE" == "201" ]]; then
  log "posted source=$SOURCE_LABEL channel=$POST_TO post_id=$TURN_POST_ID hash=$MSG_HASH http=$HTTP_CODE preview=$(echo "$LAST_MSG" | head -c 80)"
else
  log "error-http source=$SOURCE_LABEL channel=$POST_TO hash=$MSG_HASH http=$HTTP_CODE"
fi

exit 0
