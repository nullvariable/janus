#!/bin/bash
# Entrypoint for the claude-agents container.
# Runs multiple Claude Code instances in separate tmux windows.
# Attach to inspect: docker exec -it claude-agents tmux attach
#
# Each agent gets its own window with its own .mcp.json and env vars.
# If an agent exits, its pane is respawned automatically.

SESSION="claude-agents"
CLAUDE_BASE="claude --dangerously-skip-permissions"

# Install planka-cli into the venv (idempotent — skips if already installed)
if [[ -d /opt/planka-cli ]] && ! /home/node/planka-venv/bin/planka-cli --help &>/dev/null; then
  echo "[entrypoint] Installing planka-cli into venv..."
  /home/node/.local/bin/uv pip install --python /home/node/planka-venv/bin/python -e /opt/planka-cli >/dev/null 2>&1 || \
    echo "[entrypoint] WARN: planka-cli install failed"
fi

# Update Claude Code on each container start. Non-fatal: if the install fails
# (network flake, registry blip), keep the existing version and continue.
# Set SKIP_CLAUDE_UPDATE=1 to bypass (useful for offline dev).
if [[ "${SKIP_CLAUDE_UPDATE:-}" != "1" ]]; then
  echo "[entrypoint] Updating @anthropic-ai/claude-code..."
  npm_out=$(npm i -g @anthropic-ai/claude-code@latest 2>&1)
  npm_rc=$?
  echo "$npm_out" | tail -3
  if [[ $npm_rc -eq 0 ]]; then
    echo "[entrypoint] claude-code: $(claude --version 2>/dev/null || echo unknown)"
  else
    echo "[entrypoint] WARN: claude-code update failed (rc=$npm_rc), continuing with installed version"
  fi
fi

# Agent name → workdir mapping
declare -A AGENTS=(
  [health]=/agents/health
  [geordi]=/agents/geordi
  [marketing]=/agents/marketing
  [links]=/agents/links
)

# Per-agent channel list (space-separated server:<name>). Each entry produces
# one --dangerously-load-development-channels flag. Channels listed here MUST
# be registered in the agent's .mcp.json.
declare -A CHANNELS=(
  [health]="server:mattermost"
  [geordi]="server:mattermost server:heartbeat"
  [marketing]="server:mattermost server:heartbeat server:heartbeat-keywords"
  [links]="server:mattermost"
)

# Per-agent model override. Empty/unset means use the default model.
# Pinned to Haiku for cheap, high-volume link archiving.
declare -A MODELS=(
  [links]="claude-haiku-4-5-20251001"
)

# Ordered list (bash associative arrays don't preserve order)
AGENT_ORDER=(health geordi marketing links)

# Build the full claude command for an agent including its channel flags
build_claude_cmd() {
  local name="$1"
  local cmd="$CLAUDE_BASE"
  if [[ -n "${MODELS[$name]:-}" ]]; then
    cmd+=" --model ${MODELS[$name]}"
  fi
  for ch in ${CHANNELS[$name]}; do
    cmd+=" --dangerously-load-development-channels $ch"
  done
  echo "$cmd"
}

# Auto-accept startup prompts (workspace trust, dev channels confirmation).
# Targets a specific tmux window by name.
accept_startup_prompts() {
  local window="$1"
  (
    sleep 8
    tmux send-keys -t "$SESSION:$window" Enter 2>/dev/null || true
    sleep 5
    tmux send-keys -t "$SESSION:$window" Enter 2>/dev/null || true
  ) &
}

# Symlink .mcp.json from /app/agents/<name>/ into the agent's workdir
setup_agent() {
  local name="$1"
  local workdir="${AGENTS[$name]}"

  # Symlink .mcp.json into the bind-mounted project directory
  ln -sf "/app/agents/$name/.mcp.json" "$workdir/.mcp.json"

  # Source agent-specific env vars if .env exists
  if [[ -f "/app/agents/$name/.env" ]]; then
    set -a
    source "/app/agents/$name/.env"
    set +a
  fi
}

start_session() {
  tmux kill-server 2>/dev/null || true

  local first=true
  for name in "${AGENT_ORDER[@]}"; do
    local workdir="${AGENTS[$name]}"
    local cmd
    cmd=$(build_claude_cmd "$name")
    setup_agent "$name"

    if $first; then
      # Create the tmux session with the first agent
      tmux new-session -d -s "$SESSION" -n "$name" -x 200 -y 50 \
        "cd $workdir && $cmd"
      first=false
    else
      # Add a new window for subsequent agents
      tmux new-window -t "$SESSION" -n "$name" \
        "cd $workdir && $cmd"
    fi

    tmux set-option -t "$SESSION:$name" remain-on-exit on 2>/dev/null || true
    accept_startup_prompts "$name"
  done
}

start_session

# Monitor all agent windows — respawn dead panes, restart if session dies
while true; do
  sleep 10

  if ! tmux has-session -t "$SESSION" 2>/dev/null; then
    echo "[entrypoint] Session gone, restarting in 5s..."
    sleep 5
    start_session
    continue
  fi

  for name in "${AGENT_ORDER[@]}"; do
    workdir="${AGENTS[$name]}"

    # Check if this window's pane has exited
    if tmux list-panes -t "$SESSION:$name" -F '#{pane_dead}' 2>/dev/null | grep -q '^1$'; then
      echo "[entrypoint] $name exited, respawning in 5s..."
      sleep 5
      setup_agent "$name"
      cmd=$(build_claude_cmd "$name")
      tmux respawn-pane -t "$SESSION:$name" "cd $workdir && $cmd" 2>/dev/null || true
      accept_startup_prompts "$name"
    fi
  done
done
