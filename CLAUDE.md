# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Janus is a multi-agent Docker container that runs multiple Claude Code instances with shared infrastructure. Each agent gets its own Claude Code process in a dedicated tmux window, sharing MCP servers (Mattermost, scrapling, qmd), credentials, and bot tokens through a single container.

## Architecture

- **entrypoint.sh** — tmux session manager that creates one window per agent, sets per-agent env vars, launches `claude --dangerously-skip-permissions`, and respawns on crash
- **mattermost-channel/** — shared Mattermost MCP server (TypeScript/Bun) that supports multi-channel configuration via per-agent env vars
- **agents/{name}/** — per-agent glue config only (`.mcp.json`, `.env`, `CLAUDE.md`). Actual project content lives in source repos and is bind-mounted into the container

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
