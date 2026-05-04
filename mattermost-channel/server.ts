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
import { readFileSync, watch, mkdirSync, openSync, closeSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
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
// TUI tmux inject (optional path for runtimes that don't speak
// `notifications/claude/channel`, e.g. Hermes, OpenCode, Codex)
// ---------------------------------------------------------------------------
//
// When INJECT_TARGET is set to a tmux pane address (`session:window` or
// `session:window.pane`), inbound Mattermost posts are typed into that pane
// instead of being emitted as MCP channel notifications. The pane's process
// (whatever TUI is running there) sees the message as if the user typed it.
//
// IDLE_MARKER is a substring grepped from the bottom of the pane to detect
// "ready for input" — drains stay paused until it appears, so back-to-back
// messages don't interleave with an in-progress turn. The default targets
// the Hermes TUI status line; override per-runtime if needed.
//
// All other env vars have sensible defaults — the typical caller only sets
// MATTERMOST_INJECT_TARGET.
const INJECT_TARGET = process.env.MATTERMOST_INJECT_TARGET
const INJECT_IDLE_MARKER = process.env.MATTERMOST_INJECT_IDLE_MARKER ?? 'ready │'
const INJECT_DRAIN_POLL_MS = Number(process.env.MATTERMOST_INJECT_DRAIN_POLL_MS ?? '2000')
const INJECT_MAX_WAIT_MS = Number(process.env.MATTERMOST_INJECT_MAX_WAIT_MS ?? '300000')
const INJECT_POST_KEY_DELAY_MS = Number(process.env.MATTERMOST_INJECT_POST_KEY_DELAY_MS ?? '3000')
// Hermes Ink's textInput coalesces back-to-back stdin input into a paste
// buffer with a 50ms debouncer (ui-tui/src/components/textInput.tsx:920),
// then strips trailing newlines via stripTrailingPasteNewlines() before
// committing. So if our Enter arrives within 50ms of the content, it gets
// absorbed into the paste and the trailing-newline strip eats it — no
// submit. Holding >50ms before sending Enter forces the paste buffer to
// flush so Enter lands as its own k.return keypress event, which is the
// path that actually triggers cbSubmit.
const INJECT_ENTER_GAP_MS = Number(process.env.MATTERMOST_INJECT_ENTER_GAP_MS ?? '200')
// TUIs default to "new input interrupts the running turn." For a bot that
// processes inbound posts sequentially (e.g. archiving links), interruption
// is wrong — three rapid posts should each get their own turn, not the
// third aborting the second mid-fetch. Hermes's `/queue` slash command
// defers input until the current turn finishes, so we prefix injected
// messages with it by default. Set MATTERMOST_INJECT_PREFIX="" to disable
// (e.g. for runtimes that don't speak /queue) or override with the runtime's
// equivalent (`/q `, etc.). Trailing space matters.
const INJECT_PREFIX = process.env.MATTERMOST_INJECT_PREFIX ?? '/queue '

interface QueuedInjection { wrapped: string; postId: string }
const injectQueue: QueuedInjection[] = []
let injectDraining = false

// post_id de-dup, both in-process AND cross-process. Hermes runs MCP servers
// in TWO tiers (main Python agent + the Ink/TUI gateway's own sub-agent),
// each with its own mattermost-channel child. Both subscribe to the
// Mattermost websocket and both would inject the same post_id. The
// in-process Set is the fast path; the on-disk marker file (atomic O_EXCL
// create) is the cross-process tiebreaker — first to create wins, others
// see EEXIST and skip.
const recentInjects = new Set<string>()
const RECENT_INJECTS_MAX = 512
const DEDUP_DIR = `/tmp/mm-channel-dedup-${MATTERMOST_CHANNEL_ID}`
mkdirSync(DEDUP_DIR, { recursive: true })
const DEDUP_KEEP = 500

function pruneDedupDir() {
  try {
    const entries = readdirSync(DEDUP_DIR).map((name) => {
      const path = `${DEDUP_DIR}/${name}`
      try { return { name, path, mtime: statSync(path).mtimeMs } } catch { return null }
    }).filter((x): x is { name: string; path: string; mtime: number } => x !== null)
    if (entries.length <= DEDUP_KEEP) return
    entries.sort((a, b) => a.mtime - b.mtime)
    for (const old of entries.slice(0, entries.length - DEDUP_KEEP)) {
      try { unlinkSync(old.path) } catch {}
    }
  } catch {}
}

function alreadyInjected(postId: string): boolean {
  if (recentInjects.has(postId)) return true
  recentInjects.add(postId)
  if (recentInjects.size > RECENT_INJECTS_MAX) {
    const first = recentInjects.values().next().value
    if (first !== undefined) recentInjects.delete(first)
  }
  // Atomic claim across processes: O_EXCL create wins; EEXIST means another
  // process already claimed this post_id.
  const path = `${DEDUP_DIR}/${postId}`
  try {
    const fd = openSync(path, 'wx')
    closeSync(fd)
    pruneDedupDir()
    return false
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'EEXIST') return true
    // Some other fs error — log and treat as not-injected (better to risk
    // a duplicate than to silently drop).
    console.error(`[mattermost-channel] dedup file create failed: ${e.code ?? e.message}`)
    return false
  }
}

function tmux(args: string[], input?: string): { code: number; stdout: string; stderr: string } {
  const r = spawnSync('tmux', args, { input, encoding: 'utf8' })
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

function paneIsIdle(target: string): boolean {
  // Grab the bottom 3 lines and grep for the idle marker.
  const r = tmux(['capture-pane', '-pt', target, '-S', '-3'])
  return r.code === 0 && r.stdout.includes(INJECT_IDLE_MARKER)
}

function buildMattermostWrapper(post: { id: string; channel_id: string; create_at: number; message: string }, sender: string): string {
  // Single-line wrapper so it can be sent into the TUI as one paste + Enter.
  // Embedded newlines collapsed to a visible glyph so the agent can still see
  // a separator, but we don't risk submitting mid-line.
  const text = String(post.message ?? '').replace(/\r?\n/g, ' ↵ ')
  return [
    `<channel source="mattermost"`,
    ` channel_id="${post.channel_id}"`,
    ` post_id="${post.id}"`,
    ` username="${sender}"`,
    ` ts="${new Date(post.create_at).toISOString()}">`,
    text,
    `</channel>`,
  ].join('')
}

async function drainInject() {
  if (injectDraining || !INJECT_TARGET) return
  injectDraining = true
  try {
    while (injectQueue.length) {
      // Idle-wait gates injection only when there's no prefix doing the
      // queueing for us. With INJECT_PREFIX="/queue " (the default for
      // Hermes), the TUI handles queueing internally — waiting for idle
      // would block injects during long-running turns and defeat the point.
      if (!INJECT_PREFIX) {
        const start = Date.now()
        while (!paneIsIdle(INJECT_TARGET)) {
          if (Date.now() - start > INJECT_MAX_WAIT_MS) {
            const dropped = injectQueue.shift()
            console.error(
              `[mattermost-channel] inject timeout waiting for idle in ${INJECT_TARGET}; ` +
              `dropping post ${dropped?.postId ?? '?'}`,
            )
            break
          }
          await new Promise((r) => setTimeout(r, INJECT_DRAIN_POLL_MS))
        }
      }
      const item = injectQueue[0]
      if (!item) continue
      injectQueue.shift()

      // Two separate tmux send-keys calls with a >50ms gap between them.
      // Hermes Ink's textInput coalesces fast back-to-back input into a
      // paste buffer (50ms debouncer) and strips trailing newlines on
      // flush — so any Enter that arrives within the paste window gets
      // eaten. The gap forces the paste to flush before Enter lands as
      // its own keypress.
      // INJECT_PREFIX (default "/queue ") tells the TUI to defer the
      // message until the current turn finishes instead of interrupting.
      const payload = INJECT_PREFIX + item.wrapped
      const typed = tmux(['send-keys', '-t', INJECT_TARGET, payload])
      if (typed.code !== 0) {
        console.error(`[mattermost-channel] tmux send-keys (content) failed (post ${item.postId}): ${typed.stderr.trim()}`)
        continue
      }
      await new Promise((r) => setTimeout(r, INJECT_ENTER_GAP_MS))
      const submit = tmux(['send-keys', '-t', INJECT_TARGET, 'Enter'])
      if (submit.code !== 0) {
        console.error(`[mattermost-channel] tmux send-keys (Enter) failed (post ${item.postId}): ${submit.stderr.trim()}`)
        continue
      }
      console.error(`[mattermost-channel] injected post ${item.postId} into ${INJECT_TARGET}`)

      // Give the TUI a moment to leave the idle state before re-checking.
      await new Promise((r) => setTimeout(r, INJECT_POST_KEY_DELAY_MS))
    }
  } finally {
    injectDraining = false
  }
}

function enqueueInject(wrapped: string, postId: string) {
  if (alreadyInjected(postId)) {
    console.error(`[mattermost-channel] inject dedup: dropping duplicate post ${postId}`)
    return
  }
  injectQueue.push({ wrapped, postId })
  void drainInject()
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

// Cross-process broadcast — same trick as the dedup files. Hermes spawns
// mattermost-channel in two tiers (main agent + Ink/TUI gateway), so both
// processes have their own keepalive timer running. A tool call (react,
// reply, post) only reaches one of them; without this broadcast the other
// keeps ticking and Mattermost shows "still typing" long after the bot is
// done. Drops a marker file under TYPING_DIR; the fs.watch handler in
// every running instance picks it up and clears its own timer.
function broadcastStopTyping(channelId: string) {
  stopTyping(channelId)
  try {
    const path = join(TYPING_DIR, `${STOP_PREFIX}${channelId}`)
    closeSync(openSync(path, 'w'))
  } catch {
    // best-effort; if /tmp is unavailable the local stop already happened
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
      broadcastStopTyping(channel_id)
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
      broadcastStopTyping(MATTERMOST_CHANNEL_ID)
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
      // For silent-archiver agents (links), `react` is the only voice — and
      // it counts as "done" for the typing keepalive. Use broadcastStopTyping
      // so the OTHER mattermost-channel instance (hermes runs two — main
      // agent + Ink/TUI gateway sub-agent) also stops its keepalive timer;
      // otherwise typing would keep ticking on Mattermost until the
      // post-turn hook drops the stop marker.
      broadcastStopTyping(MATTERMOST_CHANNEL_ID)
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

    // Forward to the agent. When INJECT_TARGET is set, type the wrapped
    // message into the configured tmux pane (works for any TUI runtime —
    // Hermes, OpenCode, Codex, etc.). Otherwise emit the Claude-Code-native
    // channel notification.
    if (INJECT_TARGET) {
      enqueueInject(buildMattermostWrapper(post, sender_name), post.id)
    } else {
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
    }
  },

  onConnected() {
    // Log to stderr so it doesn't interfere with MCP stdio
    console.error(`[mattermost-channel] Connected to ${MATTERMOST_URL}`)
    if (INJECT_TARGET) {
      console.error(
        `[mattermost-channel] inbound mode: tmux-inject target=${INJECT_TARGET} ` +
        `idle-marker=${JSON.stringify(INJECT_IDLE_MARKER)} ` +
        `prefix=${JSON.stringify(INJECT_PREFIX)}`,
      )
    } else {
      console.error('[mattermost-channel] inbound mode: notifications/claude/channel')
    }
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
