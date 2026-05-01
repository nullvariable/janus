#!/usr/bin/env bun
/**
 * Mattermost channel plugin for Claude Code.
 *
 * Bridges a Mattermost channel to a running Claude Code session.
 * The plugin handles Mattermost connectivity; Claude handles domain-specific
 * logic per its CLAUDE.md instructions.
 *
 * Usage:
 *   claude --dangerously-load-development-channels server:mattermost
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { readFileSync, watch, mkdirSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

import { MattermostClient } from './mattermost.js'
import { loadAccess, isAllowed } from './access.js'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const STATE_DIR = process.env.MATTERMOST_STATE_DIR
  ?? join(homedir(), '.claude', 'channels', 'mattermost')

// Load .env from state dir; real env vars take precedence
try {
  const envFile = readFileSync(join(STATE_DIR, '.env'), 'utf8')
  for (const line of envFile.split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch {
  // No .env file — rely on environment variables
}

const MATTERMOST_URL = process.env.MATTERMOST_URL
const MATTERMOST_BOT_TOKEN = process.env.MATTERMOST_BOT_TOKEN
const MATTERMOST_CHANNEL_ID = process.env.MATTERMOST_CHANNEL_ID

if (!MATTERMOST_URL || !MATTERMOST_BOT_TOKEN || !MATTERMOST_CHANNEL_ID) {
  console.error(
    'Missing required config. Set MATTERMOST_URL, MATTERMOST_BOT_TOKEN, and MATTERMOST_CHANNEL_ID ' +
    `in environment or in ${join(STATE_DIR, '.env')}`
  )
  process.exit(1)
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const INSTRUCTIONS = `Messages arrive from Mattermost as <channel source="mattermost" channel_id="..." post_id="..." username="..." ts="...">.

Three tools are available:

- **reply**: respond to an inbound message in its channel. Pass the channel_id from the inbound event meta. Do NOT set root_id (no threading).
- **post**: proactively post a new message to this server's default channel (the one this MCP server is configured for). Use when you have something to say without an inbound message — e.g., after a heartbeat-triggered task completes, or when the user invokes you from the terminal without a chat context.
- **react**: add an emoji reaction to an inbound post. Use to silently acknowledge an action (e.g. "bookmark" after saving a link) without posting a reply.

If you have nothing meaningful to say, do NOT call either tool — stay silent. Empty messages are rejected. Don't reply to human-to-human conversation that isn't directed at you, and don't confirm successful actions when no confirmation is needed.

Refer to your CLAUDE.md for domain-specific instructions on how to handle messages.`

const mcp = new Server(
  { name: 'mattermost', version: '0.1.0' },
  {
    capabilities: {
      experimental: {
        'claude/channel': {},
        'claude/channel/permission': {},
      },
      tools: {},
    },
    instructions: INSTRUCTIONS,
  },
)

// ---------------------------------------------------------------------------
// Reply tool
// ---------------------------------------------------------------------------

let mmClient: MattermostClient

// ---------------------------------------------------------------------------
// Typing keepalive
// ---------------------------------------------------------------------------
//
// Mattermost displays the typing indicator for ~5s before fading. To keep it
// visible while the model works, re-send every 4s. Stop signals:
//   - reply/post tool call (response delivered)
//   - Stop-hook drops `${STATE_DIR}/typing-stop-${channel_id}` (turn finished)
//   - 5-min safety timeout

const TYPING_INTERVAL_MS = 4_000
const TYPING_MAX_MS = 5 * 60_000
const activeTypers = new Map<string, { timer: ReturnType<typeof setInterval>; deadline: number }>()

function startTyping(channelId: string) {
  stopTyping(channelId)
  const deadline = Date.now() + TYPING_MAX_MS
  void mmClient.sendTyping(channelId)
  const timer = setInterval(() => {
    if (Date.now() > deadline) {
      stopTyping(channelId)
      return
    }
    void mmClient.sendTyping(channelId)
  }, TYPING_INTERVAL_MS)
  activeTypers.set(channelId, { timer, deadline })
}

function stopTyping(channelId: string) {
  const entry = activeTypers.get(channelId)
  if (entry) {
    clearInterval(entry.timer)
    activeTypers.delete(channelId)
  }
}

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description: 'Respond to an inbound Mattermost message in its channel. Use when you have a channel_id from an inbound event.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          channel_id: { type: 'string' as const, description: 'Channel to reply in (from inbound event meta)' },
          text: { type: 'string' as const, description: 'Message text to send' },
        },
        required: ['channel_id', 'text'],
      },
    },
    {
      name: 'post',
      description:
        "Proactively post a new message to this server's default channel. Use when you have something to say without an inbound message context — e.g., heartbeat-triggered task completion, or terminal-invoked tasks. No channel_id needed.",
      inputSchema: {
        type: 'object' as const,
        properties: {
          text: { type: 'string' as const, description: 'Message text to send' },
        },
        required: ['text'],
      },
    },
    {
      name: 'react',
      description:
        'Add an emoji reaction to an inbound Mattermost post. Use to acknowledge a message silently instead of replying. Pass the post_id from the inbound event meta and an emoji name (e.g. "bookmark", "white_check_mark") without colons.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          post_id: { type: 'string' as const, description: 'Post to react to (from inbound event meta)' },
          emoji: { type: 'string' as const, description: 'Emoji name without colons, e.g. "bookmark"' },
        },
        required: ['post_id', 'emoji'],
      },
    },
  ],
}))

function emptyTextError(toolName: string) {
  return {
    content: [{
      type: 'text' as const,
      text: `error: ${toolName} text is empty. Do not call the ${toolName} tool with empty text — stay silent instead.`,
    }],
    isError: true,
  }
}

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === 'reply') {
    const { channel_id, text } = req.params.arguments as {
      channel_id: string
      text: string
    }
    if (!text || !text.trim()) return emptyTextError('reply')
    try {
      await mmClient.postMessage(channel_id, text)
      stopTyping(channel_id)
      return { content: [{ type: 'text' as const, text: 'sent' }] }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { content: [{ type: 'text' as const, text: `error: ${msg}` }], isError: true }
    }
  }

  if (req.params.name === 'post') {
    const { text } = req.params.arguments as { text: string }
    if (!text || !text.trim()) return emptyTextError('post')
    try {
      await mmClient.postMessage(MATTERMOST_CHANNEL_ID, text)
      stopTyping(MATTERMOST_CHANNEL_ID)
      return { content: [{ type: 'text' as const, text: `sent to ${MATTERMOST_CHANNEL_ID}` }] }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { content: [{ type: 'text' as const, text: `error: ${msg}` }], isError: true }
    }
  }

  if (req.params.name === 'react') {
    const { post_id, emoji } = req.params.arguments as { post_id: string; emoji: string }
    if (!post_id || !emoji) {
      return {
        content: [{ type: 'text' as const, text: 'error: react requires both post_id and emoji' }],
        isError: true,
      }
    }
    try {
      await mmClient.addReaction(post_id, emoji)
      return { content: [{ type: 'text' as const, text: 'reacted' }] }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { content: [{ type: 'text' as const, text: `error: ${msg}` }], isError: true }
    }
  }

  throw new Error(`unknown tool: ${req.params.name}`)
})

// ---------------------------------------------------------------------------
// Permission relay
// ---------------------------------------------------------------------------

const PermissionRequestSchema = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
})

mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
  const prompt =
    `🔒 Claude wants to run **${params.tool_name}**: ${params.description}\n\n` +
    `Reply \`yes ${params.request_id}\` or \`no ${params.request_id}\``
  try {
    await mmClient.postMessage(MATTERMOST_CHANNEL_ID, prompt)
  } catch {
    // If we can't post the prompt, the local terminal dialog is still available
  }
})

// Regex for permission verdict replies: "yes abcde" or "no abcde"
// ID alphabet: lowercase a-z minus 'l'
const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

// ---------------------------------------------------------------------------
// Connect and run
// ---------------------------------------------------------------------------

await mcp.connect(new StdioServerTransport())

loadAccess()

mmClient = new MattermostClient({
  url: MATTERMOST_URL,
  token: MATTERMOST_BOT_TOKEN,
  channelId: MATTERMOST_CHANNEL_ID,

  async onPosted({ post, sender_name }) {
    // Sender gating
    if (!isAllowed(post.user_id)) return

    // Show typing indicator while Claude processes — keep alive until the
    // agent calls reply/post or the Stop hook drops a stop marker.
    startTyping(post.channel_id)

    // Check for permission verdict before forwarding as chat
    const verdict = PERMISSION_REPLY_RE.exec(post.message)
    if (verdict) {
      await mcp.notification({
        method: 'notifications/claude/channel/permission' as any,
        params: {
          request_id: verdict[2].toLowerCase(),
          behavior: verdict[1].toLowerCase().startsWith('y') ? 'allow' : 'deny',
        },
      })
      return
    }

    // Forward as channel event
    await mcp.notification({
      method: 'notifications/claude/channel',
      params: {
        content: post.message,
        meta: {
          channel_id: post.channel_id,
          post_id: post.id,
          user_id: post.user_id,
          username: sender_name,
          ts: new Date(post.create_at).toISOString(),
        },
      },
    })
  },

  onConnected() {
    // Log to stderr so it doesn't interfere with MCP stdio
    console.error(`[mattermost-channel] Connected to ${MATTERMOST_URL}`)
  },

  onDisconnected() {
    console.error('[mattermost-channel] Disconnected, will reconnect...')
  },
})

// Watch the typing marker dir for stop signals dropped by
// hooks/mattermost-autopost.sh. File name format: `typing-stop-<channel_id>`
// (empty content). Lives under /tmp because it's purely ephemeral and the
// shared mattermost STATE_DIR is root-owned on some hosts.
const TYPING_DIR = '/tmp/mattermost-typing'
mkdirSync(TYPING_DIR, { recursive: true })
const STOP_PREFIX = 'typing-stop-'
watch(TYPING_DIR, (_event, filename) => {
  if (!filename || !filename.startsWith(STOP_PREFIX)) return
  const channelId = filename.slice(STOP_PREFIX.length)
  if (!channelId) return
  stopTyping(channelId)
  unlink(join(TYPING_DIR, filename)).catch(() => {})
})

await mmClient.connect()
