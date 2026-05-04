# Janus

<p align="center"><img src="docs/janus.webp" alt="Janus — Agentic AI" width="360"></p>

> Built by **[Doug Cone](https://nullvariable.com)**.
> Available for consulting on multi-agent infrastructure, AI integration, and production agent platforms.

## One container, four TUIs

Janus runs Claude Code, Hermes, OpenCode, or Codex agents from a single Docker container — each in its own tmux window, all sharing one set of MCP servers, one credential store, and one event bus. Inbound events come from Mattermost (or any source you wire in); outbound responses go back through the same channel. The `cli/janus` driver attaches to a specific agent's pane on demand.

The interesting part is bridging runtimes that don't speak Claude Code's channel protocol. The pattern is documented in [docs/tui-mcp-bridge.md](docs/tui-mcp-bridge.md); two halves, both runtime-agnostic at their boundary:

- **Input — tmux-inject.** When an inbound message arrives, the `mattermost-channel` MCP server types the wrapped payload into the agent's tmux pane via `tmux send-keys`. The TUI sees it as if the user typed it.
- **Output — post-turn hook.** Every TUI exposes a "this turn finished, run a script" hook (`Stop` for CC, `post_llm_call` for Hermes). The hook reads the assistant response and, if the agent didn't already call a Mattermost tool, posts it to the channel as a backstop.

> The trick on the input side is that Hermes's Ink-based `textInput` coalesces fast back-to-back stdin into a paste buffer with a 50ms debouncer, then strips the trailing newline on flush. Sending content + Enter as a single `tmux send-keys` call types the message but never submits it. A >50ms gap between the two send-keys calls forces the paste to flush so Enter lands as its own `k.return` keypress event — the path that actually triggers `cbSubmit`. Small detail; the difference between a working bridge and a broken one.

CC agents continue to use the native `notifications/claude/channel` event when `MATTERMOST_INJECT_TARGET` is unset, so adopting the bridge is opt-in per agent.

## What's in the box

```
┌────────────────────────────────────────────────────────────────┐
│  claude-agents container (node:22-slim + bun + uv + chromium)  │
│                                                                │
│  Shared MCP servers (one process per agent that registers):    │
│    mattermost-channel/  reply + post + react + tmux-inject     │
│    heartbeat/           interval+jitter OR cron schedules      │
│    scrapling            user-level (host bind-mounted venv)    │
│    qmd                  user-level (host bind-mounted package) │
│                                                                │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌────────┐ │
│  │ tmux: health │ │ tmux: geordi │ │ tmux: mktg   │ │ links  │ │
│  │ Claude Code  │ │ Claude Code  │ │ Claude Code  │ │ Hermes │ │
│  │ #health-log  │ │ #project-mgmt│ │ #marketing   │ │#link-  │ │
│  │ wger API     │ │ Planka,vault │ │ research     │ │ dump   │ │
│  └──────────────┘ └──────────────┘ └──────────────┘ └────────┘ │
└────────────────────────────────────────────────────────────────┘
```

Four example agents demonstrate the patterns:

| Agent | Runtime | What it does |
|---|---|---|
| **health** | Claude Code | Logs health entries (weight, BP, etc.) from a Mattermost channel via the wger API. |
| **geordi** | Claude Code | Project-management — Planka boards, vault notes, scheduled status checks. |
| **marketing** | Claude Code | Daily content generation from overnight research; cron-driven (5am M–F). |
| **links** | **Hermes** | Silent link archiver. Watches `#link-dump`, fetches each URL, writes a 3-line entry into an Obsidian vault, reacts `:bookmark:`. |

`links` is the worked example of the bridge pattern from the Hermes side — driven through tmux-inject for input and the `post_llm_call` hook for output. The other three are CC-native.

## Quick start

```bash
git clone https://github.com/nullvariable/janus.git
cd janus

# Configure host paths (defaults in docker-compose.yml; override via .env or shell env)
cp -n agents/health/.env.example agents/health/.env
# ...same for each agent you intend to run

# Build (HOST_USER controls the /home/<user> -> /home/node symlink for absolute
# paths in your ~/.claude.json)
docker compose build --build-arg HOST_USER=$(whoami)
docker compose up -d

# Attach to an agent
./cli/bin/janus attach links
```

Defaults assume your agent source projects live under `~/projects/` and your Obsidian vaults under `~/vaults/`. Every host path is overridable — see `docker-compose.yml` for the full env-var-driven list.

## Adding a new agent

### As a Claude Code agent

1. Create `agents/<name>/.mcp.json` declaring the MCP servers it needs (use `agents/health/.mcp.json` as the smallest reference, `agents/geordi/.mcp.json` for one with `heartbeat`).
2. Add `agents/<name>/.env.example` listing the env vars the `.mcp.json` references via `${VAR}`.
3. Add the agent to `entrypoint.sh`:
   - `AGENTS[<name>]=/agents/<name>` in the workdir map
   - `CHANNELS[<name>]="server:mattermost ..."` listing each MCP channel to load
   - `AGENT_ORDER` array
4. Bind-mount the source project at `/agents/<name>` in `docker-compose.yml`.

### As a Hermes agent

1. Create `agents/<name>/config.yaml` (Hermes config). Use [`agents/links/config.yaml`](agents/links/config.yaml) as the reference; the key bits are the `mcp_servers.mattermost.env.MATTERMOST_INJECT_TARGET` line (set to `claude-agents:<name>` so `mattermost-channel` knows which tmux pane to inject into) and the `hooks.post_llm_call` entry pointing at `/app/hooks/hermes-mattermost-autopost.sh`.
2. Add `agents/<name>/.env.example` listing the secrets `config.yaml` references via `${VAR}` (Mattermost creds, model API keys).
3. In `entrypoint.sh` add `KIND[<name>]=hermes` alongside the `AGENTS` / `AGENT_ORDER` entries. The runtime dispatcher will route to `build_hermes_cmd`.
4. Bind-mount the source project as in step 4 above.

The architecture details are in [`docs/tui-mcp-bridge.md`](docs/tui-mcp-bridge.md).

## Architecture details

### Volumes

| Host path (default) | Container path | Purpose |
|---|---|---|
| `~/.claude` | `/home/node/.claude` | OAuth tokens, plugin marketplace, settings |
| `~/.claude.json` | `/home/node/.claude.json` | User-level MCP server config |
| `~/.config/gh` | `/host-gh:ro` | gh CLI auth (staged on entrypoint, not migrated in place) |
| `~/projects/health-agent` | `/agents/health` | health agent source project |
| `~/projects/geordi-agent` | `/agents/geordi` | geordi agent source project |
| `~/projects/marketing-agent` | `/agents/marketing` | marketing agent source project |
| `~/projects/links-agent` | `/agents/links` | links agent source project |
| `~/vaults/geordi` | `/agents/geordi/vault` | Obsidian-style vault for geordi |
| `~/vaults/links` | `/agents/links/vault` | Obsidian `links/` folder |
| `~/projects/planka-cli` | `/opt/planka-cli` | planka-cli source (editable install at startup) |
| `~/.local/venvs/scrapling` (+ uv-managed Python) | same paths | scrapling venv + interpreter |
| `~/.bun/install/global` | `/opt/bun-global` | host bun globals (qmd + hoisted node_modules) |
| `~/.cache/ms-playwright` | `/home/node/.cache/ms-playwright` | Chromium binaries for scrapling |

All defaults are env-var-driven; see `docker-compose.yml`.

### Per-agent runtime selection

`entrypoint.sh` maintains a `KIND` map; agents not listed default to `claude`:

```bash
declare -A KIND=(
  [links]=hermes
)
```

`build_agent_cmd` dispatches to `build_claude_cmd` or `build_hermes_cmd` accordingly. CC agents get auto-acceptance for first-run prompts (workspace trust, dev channels); Hermes agents skip that since it has no equivalent.

### Per-agent channels (Claude Code)

```bash
declare -A CHANNELS=(
  [health]="server:mattermost"
  [geordi]="server:mattermost server:heartbeat"
  [marketing]="server:mattermost server:heartbeat server:heartbeat-keywords"
)
```

Each entry produces one `--dangerously-load-development-channels` flag. Channels listed here MUST also be registered in the agent's `.mcp.json`. Ignored for Hermes agents (Hermes loads MCP servers directly from `config.yaml`).

### Per-agent model override (Claude Code)

```bash
declare -A MODELS=(
)
```

Empty by default; add `[<agent>]="<model-id>"` to pin a non-default Claude model. Hermes agents pin their model in `config.yaml` instead.

### Heartbeat MCP server

`heartbeat/` injects a file's contents into a CC agent's session on a schedule. Two modes:

**Interval + jitter** — drift across restarts, no wall-clock alignment. Used by geordi for ~30 min lightweight checks.

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

**Cron** — wall-clock aligned. Used by marketing for the 5am M–F content run.

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

5-field cron with `*`, ranges, lists, and `*/n` steps. No `L`/`W`/`#`/`?` extensions. dom + dow are OR'd vixie-style when both are restricted.

### Mattermost MCP tools

| Tool | When to use |
|---|---|
| `reply(channel_id, text)` | Respond to an inbound Mattermost message. |
| `post(text)` | Proactively post to the server's configured default channel. |
| `react(post_id, emoji)` | Add an emoji reaction without replying. Used by `links`. |

`reply` and `post` reject empty/whitespace text — if you have nothing to say, stay silent. Set `MATTERMOST_INJECT_TARGET=<session>:<window>` on the MCP env to drive a non-CC TUI through tmux instead of CC channel notifications.

### Per-agent denying of user-level MCP servers

The host's `~/.claude.json` is bind-mounted, so any user-scoped MCP servers (e.g. `scrapling`, `qmd`) defined there try to launch in every agent. To suppress a user-level server for one agent, add to that agent's `.claude/settings.local.json`:

```json
{
  "deniedMcpServers": [
    { "serverName": "qmd" },
    { "serverName": "scrapling" }
  ]
}
```

The key is `deniedMcpServers` (not `disabledMcpServers` — that's not in CC's schema). Denylist takes precedence over allowlists.

### Plugins (Hindsight, etc.)

Per-project plugin enablement lives in each agent's `.claude/settings.local.json`:

```json
{
  "enabledPlugins": {
    "hindsight-memory@hindsight": true
  }
}
```

Plugin code comes from `~/.claude/plugins/` (already mounted via `~/.claude`). Two extra steps to make plugins actually work in-container:

1. **Per-project install registration.** Enabling in `settings.local.json` isn't enough — the plugin must also be *installed* for the agent's project path. Attach to the agent's tmux window and run `/plugins` → Install. This writes a `projectPath` entry to `~/.claude/plugins/installed_plugins.json`.
2. **Local services the plugin talks to.** Plugin host configs often use `127.0.0.1` which doesn't reach the container. Workaround: attach Janus to the service's Docker network (`external: true` in `docker-compose.yml`) and bind-mount a janus-specific config file over the plugin's expected path. See `agents/geordi/hindsight-claude-code.json` for a worked example.

## CLI (`janus`)

A small zero-dep Node CLI in `cli/` wraps the common docker+tmux operations.

```bash
cd ./cli && npm link              # adds `janus` to $PATH
# or run directly: ./cli/bin/janus <command>
```

| Command | What it does |
|---|---|
| `janus list` | List agent windows (index + name). |
| `janus attach [agent]` | Attach to the tmux session, optionally jumping to `<agent>`. |
| `janus send <agent> <msg>` | Send a single-line message into `<agent>`'s prompt without attaching. |
| `janus help` | Show help. |

Planned: `janus restart`, `janus update`, `janus status`.

Inside an attached session: `Ctrl-b d` detaches (agents keep running); `Ctrl-b n`/`p` cycle windows; `Ctrl-b 0..3` jump to window by index.

## Roadmap

- **OpenCode + Codex bridges** — `opencode.md` has the integration notes; only the post-turn hook is left to write (the input side is already runtime-agnostic).
- **Container ops** — nightly auto-update, CLI stubs (`restart` / `update` / `status`).
- **Mattermost** — file/image attachment support.

## License

MIT — see [LICENSE](LICENSE).
