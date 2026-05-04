#!/bin/bash
# Entrypoint for the claude-agents container.
# Runs multiple Claude Code instances in separate tmux windows.
# Attach to inspect: docker exec -it claude-agents tmux attach
#
# Each agent gets its own window with its own .mcp.json and env vars.
# If an agent exits, its pane is respawned automatically.

SESSION="claude-agents"
CLAUDE_BASE="claude --dangerously-skip-permissions"

# Stage gh CLI auth from the read-only host bind-mount into a writable
# location. The container's gh is newer than the host's and may migrate the
# hosts.yml format on first run — doing that against the host file directly
# would break the host's older gh, so we copy.
if [[ -d /host-gh ]]; then
  mkdir -p /home/node/.config/gh
  cp -r /host-gh/. /home/node/.config/gh/
  chmod 700 /home/node/.config/gh
  chmod 600 /home/node/.config/gh/*.yml 2>/dev/null || true
fi

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

# Per-agent runtime: 'claude' (Claude Code) or 'hermes' (Nous Research Hermes).
# Defaults to 'claude' if unset.
declare -A KIND=(
  [links]=hermes
)

# Per-agent channel list (space-separated server:<name>). Each entry produces
# one --dangerously-load-development-channels flag. Channels listed here MUST
# be registered in the agent's .mcp.json. Ignored for hermes agents.
declare -A CHANNELS=(
  [health]="server:mattermost"
  [geordi]="server:mattermost server:heartbeat"
  [marketing]="server:mattermost server:heartbeat server:heartbeat-keywords"
  [links]="server:mattermost"
)

# Per-agent model override (Claude Code only). Empty/unset means use the
# default model. Hermes agents pin their model in config.yaml instead.
declare -A MODELS=(
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

# Build the launch command for a hermes agent. Config and MCP servers are
# loaded from $HERMES_HOME/config.yaml (symlinked into place by setup_agent).
# --accept-hooks pre-approves shell hooks declared in config.yaml so the TUI
# doesn't block on a first-use TTY consent prompt (we run unattended).
build_hermes_cmd() {
  local name="$1"
  local workdir="${AGENTS[$name]}"
  echo "HERMES_HOME=$workdir/.hermes hermes --tui --accept-hooks"
}

# Dispatch to the right command builder based on KIND[name].
build_agent_cmd() {
  local name="$1"
  case "${KIND[$name]:-claude}" in
    hermes) build_hermes_cmd "$name" ;;
    *)      build_claude_cmd "$name" ;;
  esac
}

# Auto-accept startup prompts (workspace trust, dev channels confirmation).
# Targets a specific tmux window by name. Claude Code only — Hermes has no
# equivalent first-run prompts.
accept_startup_prompts() {
  local window="$1"
  (
    sleep 8
    tmux send-keys -t "$SESSION:$window" Enter 2>/dev/null || true
    sleep 5
    tmux send-keys -t "$SESSION:$window" Enter 2>/dev/null || true
  ) &
}

# Stage per-agent runtime config into the bind-mounted workdir. For Claude
# Code agents that's a .mcp.json symlink; for Hermes agents it's a config.yaml
# symlink plus a hermes-agent code symlink (required because the venv's python
# shebangs hardcode /home/node/.hermes/hermes-agent).
setup_agent() {
  local name="$1"
  local workdir="${AGENTS[$name]}"

  case "${KIND[$name]:-claude}" in
    hermes)
      mkdir -p "$workdir/.hermes"
      ln -sfn /home/node/.hermes/hermes-agent "$workdir/.hermes/hermes-agent"
      ln -sf "/app/agents/$name/config.yaml" "$workdir/.hermes/config.yaml"
      ;;
    *)
      ln -sf "/app/agents/$name/.mcp.json" "$workdir/.mcp.json"
      ;;
  esac

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
    setup_agent "$name"
    cmd=$(build_agent_cmd "$name")

    # Wrap the launch command so each window sources its own .env. tmux
    # windows inherit the tmux server's env (frozen at server start), so
    # vars sourced later by setup_agent never reach later windows. Sourcing
    # inside the per-window shell ensures every agent process gets its own
    # secrets (e.g. for ${...} substitution in .mcp.json / config.yaml).
    local launch="cd $workdir && [ -f .env ] && { set -a; . ./.env; set +a; }; $cmd"

    if $first; then
      # Create the tmux session with the first agent
      tmux new-session -d -s "$SESSION" -n "$name" -x 200 -y 50 \
        "$launch"
      first=false
    else
      # Add a new window for subsequent agents
      tmux new-window -t "$SESSION" -n "$name" \
        "$launch"
    fi

    tmux set-option -t "$SESSION:$name" remain-on-exit on 2>/dev/null || true
    if [[ "${KIND[$name]:-claude}" == "claude" ]]; then
      accept_startup_prompts "$name"
    fi
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
      cmd=$(build_agent_cmd "$name")
      launch="cd $workdir && [ -f .env ] && { set -a; . ./.env; set +a; }; $cmd"
      tmux respawn-pane -t "$SESSION:$name" "$launch" 2>/dev/null || true
      if [[ "${KIND[$name]:-claude}" == "claude" ]]; then
        accept_startup_prompts "$name"
      fi
    fi
  done
done
