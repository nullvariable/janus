#!/bin/bash
# Stop hook: auto-forward Claude's response to Mattermost if the agent
# forgot to call mcp__mattermost__post or mcp__mattermost__reply.
#
# Fires on every turn. Logic:
#   1. Parse hook stdin JSON for last_assistant_message + transcript_path
#   2. Find the agent's mattermost config from /app/agents/<name>/.mcp.json
#   3. Walk transcript to check if (a) the turn was mattermost/heartbeat-triggered
#      and (b) the agent didn't call a mattermost tool
#   4. If both conditions are met, POST the response to mattermost
#
# Configuration (read from the agent's .mcp.json heartbeat env block):
#   HEARTBEAT_AUTOPOST  - "true" to also forward heartbeat-triggered turns
#   AUTOPOST_MARKER     - "true" to append _(auto-forwarded)_ footer
#
# Logs every decision to /home/node/.claude/channels/mattermost/autopost.log.
# Always exits 0 — never blocks the turn.
set -euo pipefail

# Only run inside the janus container — hook has no meaning on the host
if [[ ! -d /app/agents ]]; then
  exit 0
fi

LOG_FILE="/home/node/.claude/autopost.log"
LOCK_DIR="/tmp/autopost-locks"

mkdir -p "$LOCK_DIR"

# Clean stale lock files (>10 min old)
find "$LOCK_DIR" -maxdepth 1 -type f -mmin +10 -delete 2>/dev/null || true

log() {
  mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || return 0
  echo "[$(date -Iseconds)] agent=$AGENT session=${SESSION_ID:-?} $1" >> "$LOG_FILE" 2>/dev/null || true
}

# --- Read hook input from stdin ---
INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('session_id',''))" 2>/dev/null)
TRANSCRIPT_PATH=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('transcript_path',''))" 2>/dev/null)
LAST_MSG=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('last_assistant_message',''))" 2>/dev/null)
CWD=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('cwd',''))" 2>/dev/null)

# Resolve agent name from cwd (e.g. /agents/marketing → marketing)
AGENT=$(basename "${CLAUDE_PROJECT_DIR:-$CWD}")

# --- Load mattermost config from the agent's .mcp.json ---
MCP_JSON="/app/agents/$AGENT/.mcp.json"
if [[ ! -f "$MCP_JSON" ]]; then
  log "skip-no-mcp-json"
  exit 0
fi

MM_URL=$(python3 -c "
import json
d=json.load(open('$MCP_JSON'))
s=d.get('mcpServers',{}).get('mattermost',{}).get('env',{})
print(s.get('MATTERMOST_URL',''))
" 2>/dev/null)

if [[ -z "$MM_URL" ]]; then
  log "skip-no-mattermost-config"
  exit 0
fi

MM_TOKEN=$(python3 -c "
import json
d=json.load(open('$MCP_JSON'))
print(d['mcpServers']['mattermost']['env']['MATTERMOST_BOT_TOKEN'])
" 2>/dev/null)

MM_CHANNEL=$(python3 -c "
import json
d=json.load(open('$MCP_JSON'))
print(d['mcpServers']['mattermost']['env']['MATTERMOST_CHANNEL_ID'])
" 2>/dev/null)

# Read heartbeat config flags
HB_AUTOPOST=$(python3 -c "
import json
d=json.load(open('$MCP_JSON'))
print(d.get('mcpServers',{}).get('heartbeat',{}).get('env',{}).get('HEARTBEAT_AUTOPOST','false'))
" 2>/dev/null)

MARKER=$(python3 -c "
import json
d=json.load(open('$MCP_JSON'))
print(d.get('mcpServers',{}).get('heartbeat',{}).get('env',{}).get('AUTOPOST_MARKER','false'))
" 2>/dev/null)

# --- Analyze the transcript ---
if [[ -z "$TRANSCRIPT_PATH" || ! -f "$TRANSCRIPT_PATH" ]]; then
  log "skip-no-transcript"
  exit 0
fi

# Python does the heavy lifting: walk the transcript, determine source + tool usage
ANALYSIS=$(HOOK_TRANSCRIPT_PATH="$TRANSCRIPT_PATH" python3 << 'PYEOF'
import json, sys, os

transcript_path = os.environ.get("HOOK_TRANSCRIPT_PATH", "")
if not transcript_path:
    print("no-transcript")
    sys.exit(0)

lines = []
with open(transcript_path) as f:
    for raw in f:
        raw = raw.strip()
        if raw:
            lines.append(json.loads(raw))

# Walk backwards to find the last "real" user message (not a tool_result)
last_user_idx = -1
last_user_content = ""
for i in range(len(lines) - 1, -1, -1):
    entry = lines[i]
    if entry.get("type") != "user":
        continue
    # Skip tool results — they have toolUseResult key
    if "toolUseResult" in entry:
        continue
    msg = entry.get("message", {})
    content = msg.get("content", "")
    if isinstance(content, str) and content.strip():
        last_user_idx = i
        last_user_content = content
        break

if last_user_idx < 0:
    print("no-user-message")
    sys.exit(0)

# Determine source
source = "terminal"
if last_user_content.lstrip().startswith("<channel source="):
    # Extract the source attribute
    import re
    m = re.search(r'source="([^"]+)"', last_user_content)
    if m:
        source = m.group(1)

# Walk forward from user message, check for mattermost tool calls
tool_called = False
for i in range(last_user_idx + 1, len(lines)):
    entry = lines[i]
    if entry.get("type") != "assistant":
        continue
    msg = entry.get("message", {})
    content = msg.get("content", [])
    if not isinstance(content, list):
        continue
    for item in content:
        if not isinstance(item, dict):
            continue
        if item.get("type") == "tool_use":
            name = item.get("name", "")
            if name in ("mcp__mattermost__post", "mcp__mattermost__reply"):
                tool_called = True
                break
    if tool_called:
        break

print(f"{source}|{'yes' if tool_called else 'no'}")
PYEOF
)

SOURCE=$(echo "$ANALYSIS" | cut -d'|' -f1)
TOOL_CALLED=$(echo "$ANALYSIS" | cut -d'|' -f2)

# --- Decision logic ---

# Terminal turns → never auto-forward (user can see tmux)
if [[ "$SOURCE" == "terminal" || "$SOURCE" == "no-user-message" || "$SOURCE" == "no-transcript" ]]; then
  log "skip-not-channel-turn source=$SOURCE"
  exit 0
fi

# Heartbeat turns → only forward if HEARTBEAT_AUTOPOST is true
if [[ "$SOURCE" == "heartbeat" && "$HB_AUTOPOST" != "true" ]]; then
  log "skip-heartbeat-autopost-off source=$SOURCE"
  exit 0
fi

# Agent already called a mattermost tool → no action needed
if [[ "$TOOL_CALLED" == "yes" ]]; then
  log "skip-tool-called source=$SOURCE"
  exit 0
fi

# Empty assistant message → nothing to forward
if [[ -z "${LAST_MSG// /}" ]]; then
  log "skip-empty source=$SOURCE"
  exit 0
fi

# --- Idempotency check ---
MSG_HASH=$(echo -n "$SESSION_ID:$LAST_MSG" | sha256sum | cut -c1-16)
if [[ -f "$LOCK_DIR/$MSG_HASH" ]]; then
  log "skip-duplicate hash=$MSG_HASH source=$SOURCE"
  exit 0
fi
touch "$LOCK_DIR/$MSG_HASH"

# --- Post to Mattermost ---
BODY="$LAST_MSG"
if [[ "$MARKER" == "true" ]]; then
  BODY="$BODY

_(auto-forwarded)_"
fi

# Escape for JSON
JSON_BODY=$(python3 -c "import json,sys; print(json.dumps(sys.stdin.read()))" <<< "$BODY")

HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' \
  -X POST "$MM_URL/api/v4/posts" \
  -H "Authorization: Bearer $MM_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"channel_id\": \"$MM_CHANNEL\", \"message\": $JSON_BODY}" 2>/dev/null || echo "000")

if [[ "$HTTP_CODE" == "201" ]]; then
  log "posted source=$SOURCE hash=$MSG_HASH http=$HTTP_CODE preview=$(echo "$LAST_MSG" | head -c 80)"
else
  log "error-http source=$SOURCE hash=$MSG_HASH http=$HTTP_CODE"
fi

exit 0
