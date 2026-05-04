# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Janus is a multi-agent Docker container that runs multiple TUI agents with shared infrastructure. Each agent gets its own process in a dedicated tmux window, sharing MCP servers (Mattermost, scrapling, qmd), credentials, and bot tokens through a single container. Both Claude Code and Hermes (Nous Research) are supported as agent runtimes; see `docs/tui-mcp-bridge.md` for how non-CC TUIs hook into the same channel infrastructure.

## Architecture

- **entrypoint.sh** — tmux session manager that creates one window per agent, sets per-agent env vars, launches the agent's runtime (`claude --dangerously-skip-permissions` or `hermes --tui` based on the `KIND` map), and respawns on crash
- **mattermost-channel/** — shared Mattermost MCP server (TypeScript/Bun) that supports multi-channel configuration via per-agent env vars. Set `MATTERMOST_INJECT_TARGET` to drive a TUI through tmux send-keys instead of the CC-only `notifications/claude/channel` event
- **agents/{name}/** — per-agent glue config only (CC: `.mcp.json` / Hermes: `config.yaml`, plus `.env`, `CLAUDE.md`). Actual project content lives in source repos and is bind-mounted into the container

### Container stack

Base image: `node:22-slim`. Runtime deps: Claude Code (npm), Bun (MCP servers), tmux, curl.

Credentials are mounted at runtime:
- `~/.claude` → `/home/node/.claude` (OAuth tokens)
- `~/.claude.json` → Claude user settings
- Bot tokens via docker-compose env vars

## Key Constraint

The shared mattermost-channel MCP server is generic — each agent's `.mcp.json` passes its own `MATTERMOST_CHANNEL_ID` and bot token via env vars. Avoid hardcoding channel IDs or tokens in the server itself.

## Interaction

Attach to running agents: `docker exec -it claude-agents tmux attach`, or use the `janus` CLI in `cli/`.
