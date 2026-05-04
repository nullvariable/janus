# TUI ↔ MCP bridge pattern

How to drive a TUI-based agent (Hermes, OpenCode, Codex, …) from an external event source — Mattermost, a webhook, etc. — using only MCP servers and shell hooks. No platform-specific gateways required.

## The problem this solves

`janus` was built around Claude Code's developer-channels protocol: an MCP server emits `notifications/claude/channel` and the events arrive at the agent as user messages with a structured wrapper (`<channel source="..." …>…</channel>`). That works great for CC and for nothing else — every other TUI runtime (Hermes, OpenCode, Codex) ignores the `notifications/claude/channel` notification because it isn't part of the standard MCP spec.

We want one container, multiple agent runtimes, one set of MCP servers. So we bridge the input side at the tmux layer and the output side at the runtime's hook layer.

## What we learned the hard way (read this before tuning)

The seemingly trivial "type this into a tmux pane and press Enter" is fiddly because Hermes (and other Ink-based TUIs) don't process raw stdin keystrokes the way a human terminal session does. Concrete pitfalls we hit during implementation, each fixed once and easy to regress:

1. **Bundled content + Enter doesn't submit.** `tmux send-keys -t T 'message' Enter` (one call, two args) puts the message in the input field but never fires submit. Why: hermes Ink coalesces fast back-to-back stdin into a paste buffer (50ms debouncer in `ui-tui/src/components/textInput.tsx:892-923`) and the paste-flush path strips trailing newlines via `stripTrailingPasteNewlines` (`ui-tui/src/lib/text.ts:165`). The Enter gets absorbed into the paste and removed. **Fix:** two separate `send-keys` calls with a `>50ms` gap so the paste flushes before the Enter arrives as its own `k.return` keypress (which is what triggers `cbSubmit` at `textInput.tsx:763-770`). Knob: `MATTERMOST_INJECT_ENTER_GAP_MS` (default 200ms).
2. **Hermes spawns MCP servers in two tiers.** The main Python agent loads them once; the Ink/TUI gateway's sub-agent loads them *again*. Both processes subscribe to the same Mattermost websocket and would inject the same post twice if dedup is per-process only. **Fix:** atomic cross-process dedup via `O_EXCL` marker files under `/tmp/mm-channel-dedup-<channel-id>/` keyed on `post_id`. First writer claims; second sees `EEXIST` and skips.
3. **New input interrupts a running turn by default.** Without `/queue` prefixing, two URLs posted in quick succession would have the second abort the first mid-fetch. **Fix:** prepend `/queue ` (Hermes's slash command) so the TUI defers to its own internal queue. Knob: `MATTERMOST_INJECT_PREFIX` (default `"/queue "`; set to `""` for runtimes without an equivalent, in which case idle-marker gating takes over).
4. **First-run shell hooks block on a TTY consent prompt.** `agents/<name>/config.yaml` registers `post_llm_call -> /app/hooks/hermes-mattermost-autopost.sh`; on first launch hermes wants the user to approve it. Inside an unattended container, no human exists to press y. **Fix:** `--accept-hooks` flag in `entrypoint.sh build_hermes_cmd`.
5. **Docker Desktop bind-mount cache goes stale.** When Claude Code atomic-renames `~/.claude.json`, the Docker bind-mount's snapshot inode points at a path that no longer exists and `compose up` fails with `mount src=... no such file or directory`. **Fix:** `docker compose down && docker compose up -d` rebuilds the bind-mount references from current host state. Plain `restart` doesn't clear the cache.

## The pattern

```
                       ┌──────────────────────────────────────────────┐
                       │            tmux session: claude-agents       │
                       │                                              │
[Mattermost #channel]  │   window: <agent>                            │
        │              │   ┌────────────────────────────────────┐     │
   websocket            │   │  TUI runtime (claude/hermes/...)   │     │
        ▼              │   │                                    │     │
[mattermost-channel]   │   └─────────▲──────────────────┬───────┘     │
   (MCP child)         │             │                  │             │
        │              │             │ send-keys content│ post_llm_call
        │ send-keys    │             │ + (>50ms gap)    │ (or Stop) hook
        │ content;     │             │ + send-keys Enter│
        │ Enter        │             │                  │             │
        └──────────────┼─────────────┘                  │             │
                       │                                ▼             │
                       │                         [autopost.sh]        │
                       └────────────────────────────────┬─────────────┘
                                                        │ POST /api/v4/posts
                                                        ▼
                                                 [Mattermost]
```

Two halves, both runtime-agnostic at their boundary:

1. **Input side — tmux-inject.** When a Mattermost message arrives, the `mattermost-channel/server.ts` MCP server types the message into the agent's tmux pane via two separate `tmux send-keys` calls — content first, then `Enter` — with a configurable gap (default 200ms) between them. The gap is required because Hermes's Ink-based textInput coalesces fast back-to-back stdin input into a paste buffer (50ms debouncer in `ui-tui/src/components/textInput.tsx`) and the paste-flush path explicitly strips trailing newlines via `stripTrailingPasteNewlines`. Without the gap, the trailing Enter gets absorbed into the paste and stripped — typed text appears in the input field but the submit never fires. Holding >50ms forces the paste to flush so the subsequent Enter lands as its own `k.return` keypress event (the path that actually invokes the input's `onSubmit` callback). The default prefix is `/queue ` so back-to-back messages defer to the TUI's internal queue instead of interrupting the running turn — important for sequential-processing bots like the link archiver where three rapid posts should each get their own turn. The TUI sees it as if a human typed it. Activated by setting `MATTERMOST_INJECT_TARGET` on the MCP server's env block; default fallback is `notifications/claude/channel` (CC-native).

2. **Output side — post-turn hook.** Every TUI runtime has some equivalent of "this prompt finished, run a script." That hook reads the assistant response, checks whether the agent already handled the channel side via `mcp_mattermost_*` tools, and posts the response if it didn't. Acts as a backstop for whatever in-task tool use the persona file (`CLAUDE.md` / `HERMES.md` / `AGENTS.md`) was supposed to do.

Both halves are independent. You can use only the input side (agents that always call the right tools and don't need a backstop), or only the output side (terminal-driven agents whose responses should land in chat).

## Adopting it for a new agent

### 1. Pick a tmux address

Whatever you pass as `-t` to tmux works: `<session>:<window>` or `<session>:<window>.<pane>`. For janus, `claude-agents:<agent-name>` (e.g. `claude-agents:links`).

### 2. Wire the input side

In the agent's MCP config, set `MATTERMOST_INJECT_TARGET` on `mattermost-channel`:

**Hermes (`agents/<name>/config.yaml`):**
```yaml
mcp_servers:
  mattermost:
    command: "/home/node/.bun/bin/bun"
    args: ["/app/mattermost-channel/server.ts"]
    env:
      MATTERMOST_URL: "https://mattermost.example.com"
      MATTERMOST_BOT_TOKEN: "..."
      MATTERMOST_CHANNEL_ID: "..."
      MATTERMOST_INJECT_TARGET: "claude-agents:<agent-name>"
```

**Claude Code (`agents/<name>/.mcp.json`):**
```json
{
  "mcpServers": {
    "mattermost": {
      "command": "/home/node/.bun/bin/bun",
      "args": ["/app/mattermost-channel/server.ts"],
      "env": { /* ... MATTERMOST_*, optionally MATTERMOST_INJECT_TARGET ... */ }
    }
  }
}
```

CC agents typically *don't* set `MATTERMOST_INJECT_TARGET` because CC's native dev-channels mechanism is faster (no tmux indirection, no idle polling). The flag is there if you want to test the bridge against CC for parity.

### 3. Wire the output side (the post-turn hook)

The hook is runtime-specific — pick the right script per runtime:

| Runtime | Hook event | Config location | Hook script |
|---|---|---|---|
| **Claude Code** | `Stop` | `~/.claude/settings.json` (host) or per-project `.claude/settings.local.json` | `hooks/mattermost-autopost.sh` |
| **Hermes** | `post_llm_call` | `$HERMES_HOME/config.yaml` `hooks:` block | `hooks/hermes-mattermost-autopost.sh` |
| **OpenCode** | (TBD — see *Adding a runtime* below) | `opencode.json` | `hooks/opencode-mattermost-autopost.sh` (not yet written) |
| **Codex** | (TBD — see *Adding a runtime* below) | (TBD) | (not yet written) |

For Hermes, `agents/<name>/config.yaml` gets:
```yaml
hooks:
  post_llm_call:
    - command: "/app/hooks/hermes-mattermost-autopost.sh"
```

## Components in this repo

- **`mattermost-channel/server.ts`** — the MCP server. Reads `MATTERMOST_INJECT_TARGET` at startup; when set, queues inbound posts and drains them into the configured tmux pane. When unset, behaves exactly as it always has (CC dev-channel notifications). One code path, two output modes. The wrapper format the agent sees is identical in both modes: `<channel source="mattermost" channel_id="…" post_id="…" username="…" ts="…">message</channel>`. CLAUDE.md/HERMES.md doesn't need to know which mode is active.
- **`hooks/mattermost-autopost.sh`** — Claude Code Stop hook. Walks the session's transcript JSONL, resolves the per-schedule autopost flags from `agents/<name>/heartbeats.json` for heartbeat turns, and posts the response if the agent didn't call a Mattermost tool.
- **`hooks/hermes-mattermost-autopost.sh`** — Hermes `post_llm_call` hook. Parallel logic: pulls the session via `hermes sessions export - --session-id <id>`, scans for `mcp_mattermost_*` tool calls, finds the inbound `<channel>` wrapper to extract `channel_id`/`post_id`, posts the response if needed.
- **`docs/tui-mcp-bridge.md`** — this file.

## Tuning knobs

All env vars on the `mattermost-channel` MCP server, defaults shown:

| Var | Default | Purpose |
|---|---|---|
| `MATTERMOST_INJECT_TARGET` | (unset) | tmux pane address. When unset, MCP-notification mode is used. |
| `MATTERMOST_INJECT_PREFIX` | `/queue ` | String prepended to every injected message. Default uses Hermes's `/queue` slash command so back-to-back messages defer to the TUI's internal queue rather than interrupting the running turn. Set to `""` to disable (then idle-detection gates each inject — see below); set to a different prefix for runtimes whose queue command isn't `/queue`. |
| `MATTERMOST_INJECT_IDLE_MARKER` | `ready │` | Substring grepped from the bottom of the pane to detect "TUI is idle, safe to type." Only consulted when `MATTERMOST_INJECT_PREFIX` is empty (no `/queue` to defer for us). Hermes shows `ready │` in its status bar; OpenCode/Codex use a different marker — override here. |
| `MATTERMOST_INJECT_DRAIN_POLL_MS` | `2000` | How often to recheck the pane for the idle marker while a message is queued (only active when prefix is empty). |
| `MATTERMOST_INJECT_MAX_WAIT_MS` | `300000` (5 min) | Drop a queued message if the pane never becomes idle within this window (only active when prefix is empty). |
| `MATTERMOST_INJECT_POST_KEY_DELAY_MS` | `3000` | Wait after sending the message before re-polling/looking for idle, so we don't catch the just-sent prompt and immediately re-fire. Also serves as the per-message pacing when the prefix path is active. |
| `MATTERMOST_INJECT_ENTER_GAP_MS` | `200` | Pause between the content `send-keys` call and the trailing `send-keys Enter` call. Must be >50ms to clear Hermes Ink's paste-flush debouncer; if the gap is shorter, the Enter is absorbed into the paste buffer and stripped via `stripTrailingPasteNewlines`. Increase to ~500ms if observing intermittent failed submits on slow systems. |

## Caveats and gotchas

- **Hermes runs MCP servers in two tiers.** The Python main agent loads its own MCP children, AND the Ink/TUI gateway's sub-agent loads them again — so for a single agent there are *two* `mattermost-channel` processes both subscribed to the websocket. Without cross-process dedup each post would be injected twice. The server uses an atomic `O_EXCL` marker file under `/tmp/mm-channel-dedup-<channel-id>/` keyed on `post_id` — first writer wins. If you ever see doubled messages in the input field, check whether that dedup directory is writable and whether both server instances share the same `MATTERMOST_CHANNEL_ID`.
- **Don't attach to the tmux pane while messages are flowing.** Your in-progress typing and the injected URL would interleave. For unattended bots this never matters; for debugging, detach first or use a separate `tmux attach -r` (read-only) viewer.
- **The agent receives the `<channel>` wrapper as if typed.** If the agent's runtime trims/echoes input differently than CC's dev-channels rendering, the persona file may need a small tweak to call out the wrapper format. Hermes handles it fine in our testing; behavior on OpenCode/Codex is untested.
- **Tools that reference `post_id`/`channel_id` from the inbound wrapper still work.** Both modes use the same wrapper attributes; the `mcp_mattermost_react`/`reply` tools pick them out of the user message text the same way.
- **Newlines in the inbound message are collapsed to ` ↵ ` in the wrapper.** This avoids submitting a partial message when the TUI's input field treats Enter as submit. If you need true multi-line input, switch to `paste-buffer` followed by an alternate submit key (Hermes uses `Ctrl+D` for multi-line; YMMV per runtime).
- **Per-runtime hook payload shapes differ.** The Hermes hook reads `assistant_response` and `session_id` from stdin and shells out to `hermes sessions export` for transcript context. The CC hook reads `last_assistant_message` and walks the on-disk transcript JSONL directly. Both end up at the same Mattermost POST.

## Adding a runtime

To bridge OpenCode or Codex (or any future TUI agent):

1. **Find the runtime's idle marker.** Run the TUI in tmux, capture the pane while idle, and pick a stable substring from the status line. Set it via `MATTERMOST_INJECT_IDLE_MARKER` per agent.
2. **Find the runtime's post-turn hook.** Every modern TUI agent has one: CC has `Stop`, Hermes has `post_llm_call`, OpenCode has `agent.<event>`, Codex has its own. Read the runtime's docs.
3. **Write a parallel autopost hook.** Copy `hooks/hermes-mattermost-autopost.sh`, replace the session-export call with the runtime's equivalent (or whatever lets you see the turn's tool calls), and adjust the JSON-parse for the runtime's payload shape.
4. **Wire it in `agents/<name>/...`.** Configure the runtime's MCP block with `MATTERMOST_INJECT_TARGET`, register the hook in the runtime's config file, and set `KIND[<name>]=<runtime>` in `entrypoint.sh` so the launcher uses the right binary.

Steps 1, 3, and 4 take an afternoon of iteration. The MCP server itself doesn't change — the inject path is uniform across runtimes.
