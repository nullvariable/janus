# OpenCode integration notes

Research into integrating OpenCode (github.com/sst/opencode) as a second CLI alongside Claude Code in Janus. Notes captured 2026-04-15 from a parallel code-exploration pass over `~/projects/opencode` at current HEAD.

## TL;DR

OpenCode's channels-equivalent is **better than Claude Code's** — it's a real HTTP server with sessions as first-class resources. The existing `packages/slack` package is the direct blueprint for a Mattermost integration. MCPs drop in nearly unchanged. The real migration cost is **hooks**, not transport.

## 1. Inbound message push — solved, and well

Run `opencode serve` and you get a session-aware HTTP server:

- `POST /session/{id}/message` — synchronous, streams response
- `POST /session/{id}/prompt_async` — fire-and-forget, 204 immediately
- `GET /event` — SSE stream of typed session events
- SDK: `client.session.prompt({ path: { id }, body: { parts: [...] } })`

Relevant files:
- `packages/opencode/src/server/instance/session.ts` (~L854–930) — endpoint handlers
- `packages/opencode/src/server/instance/event.ts` — SSE endpoint
- `packages/sdk/js/src/index.ts` — SDK entry point (`createOpencode()` / `createOpencodeClient()`)

## 2. The Slack package is the Mattermost blueprint

`packages/slack/src/index.ts` solves the exact problem Janus needs solved: push channel messages into a running agent session, stream tool/output events back to the channel.

Pattern:
1. Map `channel + thread_ts` → `sessionID` (line ~70). Create session on first message, reuse for subsequent messages in the thread.
2. Inject inbound via `client.session.prompt({ path: { id: sessionId }, body: { parts: [{ type: "text", text }] } })` (line ~105).
3. Subscribe to `opencode.client.event.subscribe()` and relay `message.part.updated` (type `"tool"`) events back to the channel (lines ~24–39).

Port path: copy `packages/slack/src/index.ts`, swap Slack Bolt for a Mattermost webhook receiver + outbound REST calls. Retain the channel→session mapping logic verbatim.

## 3. Session lifecycle — resume works, cold-start has a cost

State lives in SQLite at `~/.opencode/opencode.db` (Drizzle ORM, tables: `SessionTable`, `MessageTable`, `PartTable`). All prior message history + tool outputs persist across invocations.

CLI resume form: `opencode run --session <id> --agent <name> --model <provider/model> "<msg>"`
- `--continue` / `-c` resumes last session
- `--session` / `-s <id>` resumes a specific session
- `--fork` forks before continuing
- Agent and model are re-specifiable per invocation — not baked into session

Cold-start cost ~500ms–2s per process (Bun startup + Effect runtime + DB query + bootstrap: plugins, LSP, FileWatcher, VCS, Snapshot, ShareNext). Viable for fire-and-forget, but `opencode serve` + HTTP is cleaner for volume.

## 4. MCP compatibility — near drop-in

Config moves from `.mcp.json` → `opencode.jsonc` at project root or `.opencode/opencode.jsonc`. Shape is nearly identical:

```jsonc
{
  "mcp": {
    "heartbeat": {
      "type": "local",
      "command": ["node", "/path/to/heartbeat/server.js"],
      "environment": { "HEARTBEAT_FILE": "workspace/tasks/create-content.md" }
    }
  }
}
```

- Stdio transport supported natively (`packages/opencode/src/mcp/index.ts` ~L388–418)
- HTTP/SSE remote servers also supported
- Per-MCP env vars supported
- Existing Janus MCPs (mattermost-channel, heartbeat, qmd, scrapling) should work unchanged once wrapped in the right config shape

## 5. Hooks — the real migration cost

The oh-my-openagent plugin's claim of "full Claude Code hook compatibility" **does not hold**. OpenCode hooks are chat-scoped, not session-lifecycle scoped.

OpenCode's hook surface (`packages/plugin/src/index.ts` ~L222–333):
- `event` — raw bus events
- `config` — config object
- `tool` — custom tool definitions
- `provider` — inject models dynamically
- `chat.message` — new user message received
- `chat.params` / `chat.headers` — modify LLM params / request headers
- `permission.ask` — intercept permission dialogs
- `command.execute.before` — before CLI command runs
- `tool.execute.before` / `tool.execute.after` — around tool calls
- `shell.env` — inject env vars for shell commands
- `experimental.chat.messages.transform` — rewrite history
- `experimental.chat.system.transform` — modify system prompt
- `experimental.session.compacting` / `experimental.compaction.autocontinue`
- `experimental.text.complete`
- `tool.definition` — dynamically modify tool schemas

**Missing relative to Claude Code:**
- No `UserPromptSubmit`, `Stop`, `SessionStart`, `PreToolUse`/`PostToolUse` parity at the session level
- No lifecycle hook for external events arriving
- No cron/interval hooks (keep that as an MCP concern — heartbeat MCP works)

Migration strategy for Claude Code hook-based behaviors:
- `UserPromptSubmit` → `chat.message` hook
- `SessionStart` → no direct equivalent; use plugin initialization or the `event` hook listening for session-start bus events
- `Stop` → no equivalent; consider an MCP-pushed sentinel or bus-event subscription
- Cron/heartbeat → keep as MCP, unchanged

Plugins are TypeScript/JS modules and are strictly more powerful than hooks — they can define custom tools, register workspace adaptors, and subscribe to the internal bus. If a behavior can't be hung off a hook cleanly, write a plugin.

## 6. Event/observability — read-only, not pre-send

`/event` SSE endpoint emits typed events (`packages/opencode/src/v2/session-event.ts`):
- Prompt, Step (started/ended with tokens), Text (started/delta/ended), Reasoning (started/delta/ended), Tool (input.started/delta/ended, called, success, error), Control (retried, compacted)

External subscription: `GET /event?directory=...&workspace=...` returns SSE. SDK has an auto-generated SSE client with retry/backoff.

**Gotcha for middleware:** observation is passive. There is no pre-send interception seam analogous to a Claude Code hook that gates outbound content. Middleware that needs to scan assistant output *before* it reaches the user has to do post-facto scan-and-react, not block-and-gate.

## 7. Impact on the Janus thesis

The "channels" concern reversed: OpenCode's push surface is cleaner than Claude Code's, not weaker. The revised multi-CLI strategy:

- **OpenCode** → `opencode serve` + HTTP push, Slack-package pattern ported for Mattermost
- **Claude Code** → channels (existing)
- **CLIs without a server** → fall back to heartbeat-driven pull via MCP

Janus's abstraction stays at the sidecar layer and translates per-CLI; from the agent operator's perspective, it's still "one interface to drop a message into any CLI."

Middleware implications for the prompt-guard thesis:
- **Inbound scan**: 100% clean. Sidecar intercepts before calling `POST /session/{id}/message`. Works uniformly across all CLIs if implemented in the sidecar.
- **Outbound scan**: asymmetric. OpenCode SSE is post-facto, so scan-and-react rather than gate-and-block. Framing: "observability + alert" on outbound, "gate" only on inbound. Good enough for the "BYO scanner" thesis, but not true bidirectional middleware.

## 8. Open questions / not-yet-verified

- Does `opencode serve` support multiple concurrent sessions on one server process, or is the Janus model "one server per agent"? Slack package suggests many sessions per server (channel+thread → sessionID mapping), so single shared server is likely.
- Auth model on `opencode serve` HTTP — is it bound to localhost, is there an auth token, is it safe to expose across containers? Check before wiring.
- Does `opencode run --session <id>` work against a session that was created via the HTTP API, or are they separate namespaces? Test before committing to hybrid CLI+server usage.
- Plugin loading mechanics — how does a Janus-shipped plugin get registered per-agent without polluting the host's OpenCode config?

## 9. Suggested next step if pursuing this

Weekend spike:
1. `opencode serve` on a single test agent, verify auth/network story
2. Clone `packages/slack`, replace Slack Bolt wiring with Mattermost webhook + REST
3. Port one Janus agent (marketing is the simplest — cron-driven, low interactivity) to OpenCode
4. Verify existing MCPs load via `opencode.jsonc`
5. Identify the subset of Claude Code hook behaviors that need translation and catalog them against the OpenCode hook list above

If the spike lands, the hook migration is the main remaining effort.
