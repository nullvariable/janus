# planka-channel

MCP server that **receives Planka webhooks**, debounces and queues card-scoped events, and exposes a small read-side + outbound-comment toolset to a Janus agent. Sibling to `mattermost-channel/`; deliberately decoupled — no shared code.

## Why this exists

Today's Planka triage runs as a `loop /planka-triage` cron skill that polls `/api/notifications/unread` every 10 minutes — ~3 min @mention latency. This server replaces the polling wake-up with Planka's native webhook firing while preserving the skill's idempotency semantics.

Planka 2.x ships built-in webhooks (HTTP POST with Bearer token auth, board-scoped, full event taxonomy — `cardCreate`, `commentCreate`, `notificationCreate`, etc., see `server/api/models/Webhook.js` in the Planka source). This server is the receiver.

## Configuration

Per-agent, in the agent's `.mcp.json`:

```json
{
  "mcpServers": {
    "planka": {
      "command": "/home/node/.bun/bin/bun",
      "args": ["/app/planka-channel/server.ts"],
      "env": {
        "PLANKA_URL": "${PLANKA_URL}",
        "PLANKA_USERNAME": "${PLANKA_USERNAME}",
        "PLANKA_PASSWORD": "${PLANKA_PASSWORD}",
        "PLANKA_BOARD_ID": "${PLANKA_BOARD_ID}",
        "PLANKA_WEBHOOK_PORT": "8089",
        "PLANKA_WEBHOOK_TOKEN": "${PLANKA_WEBHOOK_TOKEN}",
        "PLANKA_STATE_DIR": "/home/node/.claude/channels/planka",
        "PLANKA_LOG_ALL_EVENTS": "1"
      }
    }
  }
}
```

`PLANKA_BOARD_ID` is the per-agent isolator — one board per MCP process. To run a second agent on a second board, give it a different `PLANKA_WEBHOOK_PORT` and a different webhook in Planka.

### Multi-board agents

For an agent that watches more than one board, use plural form plus an explicit instance name:

```
PLANKA_BOARD_IDS=B1,B2,B3
PLANKA_INSTANCE_NAME=myagent
```

`PLANKA_INSTANCE_NAME` is the state-dir label (state lives at `${PLANKA_STATE_DIR}/<instance>/`) and the Stop-hook marker filename. It's required when watching more than one board; for single-board agents it defaults to the board id (preserving today's path).

Register one webhook per board in Planka, all pointing at the same URL (`http://<container>:<port>/webhook`) with the same `accessToken`. The server filters incoming events by checking each event's `boardId` against the `PLANKA_BOARD_IDS` set, so events from other boards are silently dropped. Card events stay scoped to one bundle per card; cards from different boards just get different bundles.

Bundles, audit rows, and channel notifications all carry the actual event's `board_id`, not a fixed value, so the agent can tell which board a bundle came from.

### Auth: token vs. password

Two auth modes are supported:

- **`PLANKA_TOKEN`** (preferred): a Bearer token (Planka access token JWT or a user API key). The server sniffs JWT vs. opaque key and uses `Authorization: Bearer …` or `x-api-key: …` accordingly. No login round-trip on startup.
- **`PLANKA_USERNAME` + `PLANKA_PASSWORD`**: classic login flow that mints a JWT via `POST /api/access-tokens`. The server auto-refreshes on 401.

If you authenticate as a SHARED admin user but need event-filtering scoped to a different bot identity, set `PLANKA_BOT_USER_ID` to override what `/api/users/me` returns.

## Webhook registration in Planka

Each agent needs one webhook configured in Planka pointing at this server. Either via the Planka UI or `POST /api/webhooks` with:

```json
{
  "name": "cos-agent",
  "url": "http://cos-agent:8089/webhook",
  "accessToken": "<value of PLANKA_WEBHOOK_TOKEN>",
  "boardId": "<value of PLANKA_BOARD_ID>"
}
```

The container is reachable at `<container-name>:8089` from any other container on the same Docker network as your Planka instance. The `accessToken` is sent back as `Authorization: Bearer <token>` on every webhook POST; the receiver rejects mismatches with 401.

Generate a token with `openssl rand -hex 32`.

## Tools

| Tool | Purpose |
|---|---|
| `events.list_pending` | Envelopes ready to claim (debounce elapsed, not in_flight). |
| `events.claim` | Lock an event for processing. Sets `in_flight` on the card. |
| `events.complete` | Advance idempotency, clear lock, append audit row. |
| `card.get` | Full card detail via REST. |
| `card.comment` | Post a comment back to Planka. |

Mutations beyond comments stay in `plnk` (each agent's per-user CLI).

## State

Per-board, under `${PLANKA_STATE_DIR}/<board_id>/`:

- `queue.jsonl` — append-only event log; survives restart
- `state.json` — `processed_notifications`, `processed_actions[cardId]`, `last_event_id_acked`. Atomic-rename writes.
- `audit.jsonl` — one row per `events.complete`. Schema matches the legacy `_runtime_planka_loop_audit.jsonl`.
- `server.log` — webhook listener up/down, auth rejections, route errors. Tail this for diagnostics.

State field names mirror the planka-triage skill's `_runtime_planka_loop.json` so prompt logic ports without renaming.

## Bring-up

1. Add `PLANKA_BOARD_ID` and a freshly generated `PLANKA_WEBHOOK_TOKEN` to the agent's `.env` (in `~/<workspace>/.env`).
2. Build and start the agent's container.
3. Register the webhook in Planka (UI or API). Use `http://<container-name>:8089/webhook` and the same token.
4. Tail `${STATE_DIR}/<board_id>/server.log` and confirm `webhook listener up` shows on startup.
5. Trigger a card event (comment, move, etc.) and confirm an event_id appears in `queue.jsonl`.

`PLANKA_LOG_ALL_EVENTS=1` (default in `agents/cos/.mcp.json`) logs each accepted event to `server.log` for first-run discovery; flip to `0` once the event taxonomy is confirmed.

## Smoke test

```bash
# In-container, reach the listener directly with a fake event:
docker exec cos-agent curl -s -X POST http://localhost:8089/webhook \
  -H "Authorization: Bearer $PLANKA_WEBHOOK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"event":"cardCreate","data":{"item":{"id":"X","boardId":"<your-board-id>"}}}'

# Should return 200 ok and append a line to queue.jsonl.
# Wrong token: 401. Wrong board: 200 (silently dropped, not in queue).
```
