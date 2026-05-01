# Janus

<p align="center"><img src="docs/janus.webp" alt="Janus — Agentic AI" width="360"></p>

> **Personal multi-agent rig.** This is the stack I run for my own AI agents — one Docker container, multiple Claude Code processes side-by-side, shared MCP servers and credentials. It's not a turnkey product. It's documented because the architecture and the gotchas (per-agent MCP denying, plugin install registration, multi-Claude-in-tmux, scheduled prompts via heartbeat) might be useful if you're building something similar.

Multi-agent Docker container running multiple Claude Code instances side-by-side with shared infrastructure. Each agent runs as its own `claude` process in a dedicated tmux window, sharing one container's credentials, MCP servers, plugin marketplace, and bind-mounted host tooling.

## Architecture

```
┌────────────────────────────────────────────────────────────────┐
│  claude-agents container (node:22-slim + bun + uv + chromium)  │
│                                                                │
│  Shared MCP servers (one process per agent that registers):    │
│    mattermost-channel/  reply + post + react tools             │
│    heartbeat/           interval+jitter OR cron schedules      │
│    scrapling            user-level (host bind-mounted venv)    │
│    qmd                  user-level (host bind-mounted package) │
│                                                                │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌────────┐ │
│  │ tmux: health │ │ tmux: geordi │ │ tmux: mktg   │ │ links  │ │
│  │ Claude Code  │ │ Claude Code  │ │ Claude Code  │ │ Haiku  │ │
│  │ #health-log  │ │ #project-mgmt│ │ #marketing   │ │#link-  │ │
│  │ wger API     │ │ Planka,vault │ │ research     │ │ dump   │ │
│  │              │ │ heartbeat/30m│ │ heartbeat/cr │ │→ vault │ │
│  └──────────────┘ └──────────────┘ └──────────────┘ └────────┘ │
│                                                                │
│  Bind-mounts: credentials, OAuth, plugin marketplace, project  │
│  source, host venvs, host bun globals, playwright cache,       │
│  Obsidian vaults, planka-cli source                            │
└────────────────────────────────────────────────────────────────┘
```

The four agents shown above (`health`, `geordi`, `marketing`, `links`) are the example agents I run. Treat them as templates — swap them for your own. See [Agents](#agents) below.

Mounted volumes (see `docker-compose.yml` for the full, env-var-driven list):

| Host path (default) | Container path | Purpose |
|---|---|---|
| `~/.claude` | `/home/node/.claude` | OAuth tokens, plugin marketplace, settings |
| `~/.claude.json` | `/home/node/.claude.json` | User-level MCP server config |
| `~/projects/health-agent` | `/agents/health` | health agent source project |
| `~/projects/geordi-agent` | `/agents/geordi` | geordi agent source project |
| `~/projects/marketing-agent` | `/agents/marketing` | marketing agent source project |
| `~/projects/links-agent` | `/agents/links` | links agent source project (CLAUDE.md only) |
| `~/vaults/geordi` | `/agents/geordi/vault` | Obsidian-style vault for geordi |
| `~/vaults/links` | `/agents/links/vault` | Obsidian `links/` folder where the links agent writes month files |
| `~/projects/planka-cli` | `/opt/planka-cli` | planka-cli source (editable install at startup) |
| `~/.local/venvs/scrapling` + `~/.local/share/uv/python/.../cpython-3.12-...` | same paths | scrapling venv + its uv-managed Python |
| `~/.bun/install/global` | `/opt/bun-global` | host bun globals (qmd + hoisted node_modules) |
| `~/.cache/ms-playwright` | `/home/node/.cache/ms-playwright` | Chromium binaries for scrapling |
| `agents/geordi/hindsight-claude-code.json` | `/home/node/.hindsight/claude-code.json` | Hindsight URL override (Docker network, not 127.0.0.1) |

All host paths can be overridden via env vars in your shell or a `.env` file next to `docker-compose.yml` — see the compose file for the full list.

A `/home/<HOST_USER> -> /home/node` symlink baked into the Dockerfile makes absolute host home paths in `~/.claude.json` resolve correctly inside the container. Build with `docker compose build --build-arg HOST_USER=$(whoami)` to set this to your host username.

## Directory Structure

```
janus/
├── Dockerfile
├── docker-compose.yml
├── entrypoint.sh              # tmux session manager (multi-window, per-agent channels)
├── README.md
├── CLAUDE.md                  # janus project notes
│
├── mattermost-channel/        # shared Mattermost MCP server
│   ├── server.ts              # MCP entry point — reply + post + react tools
│   ├── mattermost.ts          # WebSocket client + REST API
│   ├── access.ts              # sender allowlist / access control
│   └── package.json
│
├── heartbeat/                 # generic scheduled-trigger MCP server
│   ├── server.ts              # interval+jitter OR cron mode
│   └── package.json
│
├── cli/                       # zero-dep Node CLI (`janus`)
│   ├── bin/janus              # the executable
│   └── package.json
│
└── agents/                    # per-agent config (channel, env, overrides)
    ├── health/
    │   ├── .mcp.json          # agent-specific MCP config
    │   └── .env.example
    │
    ├── geordi/
    │   ├── .mcp.json
    │   ├── .env.example
    │   └── hindsight-claude-code.json   # Hindsight API override for container network
    │
    ├── marketing/
    │   ├── .mcp.json
    │   └── .env.example
    │
    └── links/
        ├── .mcp.json                    # #link-dump channel, dedicated `links` bot token
        └── .env.example
```

## Agents

The four example agents below are the ones I run. They're configured here to demonstrate the patterns — sub in your own.

### health

Health-tracking agent. Monitors a Mattermost channel for manual entries (weight, BP, heart rate, water, food) and logs them via the wger API.

- **Source project:** `~/projects/health-agent` (override via `HEALTH_AGENT_DIR`)
- **Mattermost channel:** `#health-log`
- **External services:** wger API

### geordi

Project-management agent. Manages Planka boards (task tracking, plan evaluation), posts updates to a project channel, and searches via Kagi.

- **Source project:** `~/projects/geordi-agent` (override via `GEORDI_AGENT_DIR`)
- **Mattermost channel:** project channel of your choice
- **External services:** Planka API, Kagi search
- **Heartbeat:** every ~30 min ± 2 min (interval mode), reads `HEARTBEAT.md` for due-date checks

### marketing

Daily content-generation agent. Reads scored research dropped overnight by an external pipeline (n8n in my setup), picks top stories, generates short post drafts, and posts a status summary to Mattermost.

- **Source project:** `~/projects/marketing-agent` (override via `MARKETING_AGENT_DIR`)
- **Mattermost channel:** `#marketing`
- **External services:** Kagi search (Skill), Hindsight memory plugin
- **Model:** Opus 4.6
- **Heartbeat:** cron `0 5 * * 1-5` (5am local time, Mon–Fri), reads `workspace/tasks/create-content.md`

### links

Silent link archiver. Watches a `#link-dump` Mattermost channel for URLs, fetches each page, writes a 3-line entry (URL / <80-word summary / 3–5 keywords) into an Obsidian-style vault under `links/<year>/<month>.md`, and reacts with `:bookmark:` to acknowledge. Does not reply, post, or engage with non-URL messages.

- **Source project:** `~/projects/links-agent` (override via `LINKS_AGENT_DIR`)
- **Mattermost channel:** `#link-dump` (channel ID configured in `agents/links/.mcp.json`)
- **Vault destination:** `~/vaults/links` (override via `LINKS_VAULT_DIR`); mounted at `/agents/links/vault` inside the container
- **Model:** Haiku 4.5 (pinned via `MODELS` map in `entrypoint.sh` — keeps archival cheap)
- **Heartbeat:** none. Event-driven only.

## Key Design Decisions

### One container, multiple Claude Code processes

Each agent runs its own `claude` process in a separate tmux window. This gives each agent its own context window (no cross-contamination) while sharing a single container's credentials and MCP servers.

### Per-agent Mattermost configuration

`mattermost-channel/` is a generic Bun MCP server. Each agent registers its own copy in `agents/<name>/.mcp.json` with agent-specific env vars (URL, bot token, channel ID, access policy). Each bot account is unique per agent so bot posts are attributable.

### Mounted project volumes

Agent-specific project content (CLAUDE.md, scripts, vault) lives in its source project directory and is bind-mounted into the container. The `agents/` directory here holds only the glue config (`.mcp.json`, `.env`) — not duplicated project content.

### Credential sharing

One set of mounts for:
- `~/.claude` — Claude OAuth tokens
- `~/.claude.json` — Claude user settings
- Bot tokens via env vars in docker-compose.yml

## Entrypoint Behavior

`entrypoint.sh` manages a tmux session with one window per agent:

1. On first start, install `planka-cli` (editable) from the bind-mounted source into `/home/node/planka-venv` if not already installed
2. For each agent directory in `agents/`:
   - Create a tmux window named after the agent
   - Symlink `/app/agents/<name>/.mcp.json` into the agent's bind-mounted workdir
   - Source `/app/agents/<name>/.env` if it exists
   - Launch `claude --dangerously-skip-permissions --dangerously-load-development-channels server:mattermost --dangerously-load-development-channels server:heartbeat`
3. Monitor all windows; respawn crashed agents (10s tick)
4. Expose tmux for live interaction (see below)

## Attaching to a session

The easiest way is the `janus` CLI (see below):

```bash
janus attach              # attach to active window
janus attach geordi       # attach and jump straight to geordi
```

Or directly via docker + tmux:

```bash
docker exec -it claude-agents tmux attach
docker exec -it claude-agents tmux attach -t claude-agents \; select-window -t geordi
```

Inside the session:
- `Ctrl-b d` — detach (leaves agents running)
- `Ctrl-b n` / `Ctrl-b p` — next / previous window
- `Ctrl-b 0` / `Ctrl-b 1` / `Ctrl-b 2` / `Ctrl-b 3` — jump to window by index (health=0, geordi=1, marketing=2, links=3)

## CLI (`janus`)

A small zero-dep Node CLI in `cli/` wraps the common docker+tmux operations.

### Install

```bash
cd ./cli && npm link
# `janus` is now on $PATH
```

Or run directly without installing: `./cli/bin/janus <command>`.

### Commands

| Command | What it does |
|---------|-------------|
| `janus list` | List agent windows in the running session (index + name) |
| `janus attach [agent]` | Attach to the tmux session, optionally jumping to `<agent>` |
| `janus send <agent> <msg>` | Send a single-line message into `<agent>`'s prompt (uses `tmux send-keys -l` + Enter — no need to attach) |
| `janus help` | Show help |

### Not yet implemented

| Command | Planned behavior |
|---------|-----------------|
| `janus restart [agent]` | Respawn one or all agent panes via tmux respawn-pane |
| `janus update` | Run `claude install` (or `npm update -g @anthropic-ai/claude-code`) inside the container, then restart |
| `janus status` | Show context window usage and running state per agent |

### Per-agent channels

Channel flags (`--dangerously-load-development-channels server:<name>`) are declared per-agent in the `CHANNELS` associative array in `entrypoint.sh`:

```bash
declare -A CHANNELS=(
  [health]="server:mattermost"
  [geordi]="server:mattermost server:heartbeat"
  [marketing]="server:mattermost server:heartbeat server:heartbeat-keywords"
  [links]="server:mattermost"
)
```

Each entry produces one `--dangerously-load-development-channels` flag for that agent. Channels listed here MUST also be registered in the agent's `.mcp.json` — Claude Code will print a warning otherwise.

### Per-agent model override

A `MODELS` associative array next to `CHANNELS` lets individual agents pin a non-default Claude model. Agents not listed fall through to Claude Code's default.

```bash
declare -A MODELS=(
  [links]="claude-haiku-4-5-20251001"
)
```

Used by `links` to keep high-volume archival cheap. `build_claude_cmd` appends `--model <id>` only when a value is set.

## Heartbeat MCP server

`heartbeat/` is a generic Bun MCP server that injects a file's contents into the agent's session on a schedule. Two scheduling modes are supported — pick one per agent.

### Mode 1: interval + jitter

Used by geordi for "lightweight check every ~30 min" semantics. Tick spacing drifts across restarts, no wall-clock alignment.

```json
"heartbeat": {
  "command": "/home/node/.bun/bin/bun",
  "args": ["/app/heartbeat/server.ts"],
  "env": {
    "HEARTBEAT_FILE": "/agents/<name>/HEARTBEAT.md",
    "HEARTBEAT_INTERVAL_MINUTES": "30",
    "HEARTBEAT_JITTER_MINUTES": "2"
  }
}
```

### Mode 2: cron

Used by marketing for the daily 5am M–F content run. Wall-clock aligned, fires on a 5-field cron expression. Setting `HEARTBEAT_CRON` takes precedence over interval/jitter.

```json
"heartbeat": {
  "command": "/home/node/.bun/bin/bun",
  "args": ["/app/heartbeat/server.ts"],
  "env": {
    "HEARTBEAT_FILE": "/agents/<name>/workspace/tasks/create-content.md",
    "HEARTBEAT_CRON": "0 5 * * 1-5",
    "HEARTBEAT_LABEL": "create-content"
  }
}
```

Cron syntax: standard 5-field (minute hour dom month dow). Supports `*`, single values, `a-b` ranges, `a,b,c` lists, and `*/n` steps. No `L`/`W`/`#`/`?` extensions. dom + dow are OR'd vixie-style when both are restricted. Logs `next tick at <ISO>` after each schedule for debugging.

### Add heartbeat to a new agent

1. Drop a `HEARTBEAT.md` (or other prompt file — `tasks/foo.md` works too) in the agent's project. The file content IS the prompt — write it as instructions to the agent.
2. Add a `heartbeat` block to the agent's `.mcp.json` with either interval or cron config (above).
3. Add `server:heartbeat` to the agent's `CHANNELS` entry in `entrypoint.sh`.
4. Add a short note to the agent's `CLAUDE.md` explaining how heartbeat events differ from user input — the file content is the prompt.

Heartbeat is one-way (no tools). Agents act on heartbeat content via their other registered channels — most often the `post` tool on the mattermost MCP server (see below).

## Mattermost MCP server tools

The `mattermost-channel/` server exposes three tools:

| Tool | When to use |
|---|---|
| `reply(channel_id, text)` | Respond to an inbound Mattermost message. `channel_id` comes from the inbound event meta. |
| `post(text)` | Proactively post to the server's configured default channel (its `MATTERMOST_CHANNEL_ID`). No `channel_id` argument needed. Use for heartbeat-triggered task completions and terminal-invoked tasks where there's no inbound message context. |
| `react(post_id, emoji)` | Add an emoji reaction (e.g. `"bookmark"`, `"white_check_mark"`) to an inbound post without replying. Used by silent agents like `links` to acknowledge a save without generating noise. Emoji name should be passed without surrounding colons. |

`reply` and `post` reject empty/whitespace text — if you have nothing to say, stay silent.

## User-level MCP servers and per-agent denying

The host's `~/.claude.json` is bind-mounted into the container, so any user-scoped MCP servers (e.g. `scrapling`, `qmd`) defined there try to launch in every agent. Two recurring issues:

1. **Absolute host paths.** Servers configured with paths like `/home/<HOST_USER>/.local/venvs/scrapling/bin/scrapling` won't resolve inside the container by default. Janus mitigates this via a `/home/<HOST_USER> -> /home/node` symlink baked into the Dockerfile, so absolute host home paths still work — but the binary itself (and any native deps) must be reachable. For Python venvs that means bind-mounting both the venv directory AND the Python interpreter it symlinks to. See the scrapling mounts in `docker-compose.yml` as the canonical example.

2. **Not every agent should run every user-level server.** To suppress a user-level MCP server for one agent, add a `deniedMcpServers` entry to that agent's `.claude/settings.local.json`:

   ```json
   {
     "deniedMcpServers": [
       { "serverName": "qmd" },
       { "serverName": "scrapling" }
     ]
   }
   ```

   The denylist key is `deniedMcpServers` (not `disabledMcpServers` — that one doesn't exist in Claude Code's schema). Each entry is an object with `serverName`. The denylist takes precedence over allowlists across all scopes.

## Plugins (Hindsight, etc.)

Per-project plugin enablement lives in each agent's `.claude/settings.local.json`:

```json
{
  "enabledPlugins": {
    "hindsight-memory@hindsight": true
  }
}
```

The plugin code itself comes from `~/.claude/plugins/` which is already mounted via `~/.claude`. But two extra steps are needed for things to actually work inside the container:

1. **Per-project install registration.** Enabling a plugin in `settings.local.json` is not enough — the plugin must also be *installed* for the agent's project path. The cleanest path: attach to the agent's tmux window and run `/plugins`, then Install. This adds a `projectPath` entry to `~/.claude/plugins/installed_plugins.json`.

2. **Local services the plugin talks to.** If the plugin connects to a host-side service (like Hindsight's API), the host config likely uses `127.0.0.1` which doesn't reach the container. Workaround:
   - Attach Janus to whatever Docker network the service lives on (e.g. an `external: true` network configured in `docker-compose.yml`)
   - Bind-mount a janus-specific config file over the plugin's expected path. Geordi uses `agents/geordi/hindsight-claude-code.json` mounted at `/home/node/.hindsight/claude-code.json`, pointing at the in-network DNS name instead of `127.0.0.1`.

## Context window management

Claude Code's context window can fill up over a long-running session. Plan: nightly cron in the entrypoint that runs `claude install` (Claude Code does NOT auto-update) followed by a clean restart of each agent's pane. Both health and geordi keep canonical state on disk (memory files, Planka, vault), so dropping in-session memory is safe. **Not yet implemented.**

## Roadmap

- **Public release polish** — config-driven agent declarations, per-agent template generator, fuller quickstart docs
- **Multi-CLI support** — Gemini CLI / OpenCode adapters; tmux adapter for non-MCP CLIs; per-CLI launch config (notes in `opencode.md`)
- **Container ops** — nightly auto-update, CLI stubs (`restart` / `update` / `status`), WSL bind-mount edge cases
- **Mattermost** — file/image attachment support (save-to-disk, then lazy fetch tool)
- **Cleanup** — drop dormant agent skeletons, tighten the example set

## License

MIT — see [LICENSE](LICENSE).
