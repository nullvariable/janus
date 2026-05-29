#!/usr/bin/env bun
/**
 * Planka channel MCP server for Janus agents.
 *
 * - Receives Planka webhooks on PLANKA_WEBHOOK_PORT.
 * - Bundles per card during PLANKA_PUSH_DELAY_MS (default 60s).
 * - Dispatches one bundle at a time, gated by a cross-card throttle of
 *   PLANKA_THROTTLE_MS (default 5min) measured from the last Stop event.
 * - Emits each bundle as a `notifications/claude/channel` (Claude Code) and,
 *   when PLANKA_INJECT_TARGET is set, also via tmux send-keys (hermes path).
 * - When idle for PLANKA_COMPACT_AFTER_IDLE_MS, sends `/compact` into
 *   PLANKA_TMUX_TARGET to trim the agent's context.
 * - Pull tools (events.list_pending / claim) preserved as a debug escape.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { join } from 'node:path'
import { homedir } from 'node:os'
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  watch,
} from 'node:fs'
import { spawnSync } from 'node:child_process'

import { PlankaClient } from './planka.js'
import { Queue, narrateBundle } from './queue.js'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const STATE_DIR = process.env.PLANKA_STATE_DIR
  ?? join(homedir(), '.claude', 'channels', 'planka')

const PLANKA_URL = process.env.PLANKA_URL
// Auth: prefer a Bearer token (API key or pre-minted JWT) if provided.
// Falls back to username/password login flow when PLANKA_TOKEN is unset.
const PLANKA_TOKEN = process.env.PLANKA_TOKEN || null
const PLANKA_USERNAME = process.env.PLANKA_USERNAME
const PLANKA_PASSWORD = process.env.PLANKA_PASSWORD
const PLANKA_BOT_USER_ID = process.env.PLANKA_BOT_USER_ID || null
// Multi-board support: PLANKA_BOARD_IDS=a,b,c is preferred. PLANKA_BOARD_ID
// (singular) is honored as a fallback so existing single-board agents keep
// working without config changes.
const PLANKA_BOARD_IDS_RAW = process.env.PLANKA_BOARD_IDS ?? process.env.PLANKA_BOARD_ID ?? ''
const PLANKA_BOARD_IDS = new Set(
  PLANKA_BOARD_IDS_RAW.split(',').map((s) => s.trim()).filter(Boolean),
)
// State-dir label. Multi-board agents must set this. Single-board agents
// default to the board id, preserving the existing path.
const PLANKA_INSTANCE_NAME = process.env.PLANKA_INSTANCE_NAME
  ?? (PLANKA_BOARD_IDS.size === 1 ? [...PLANKA_BOARD_IDS][0] : '')
const PLANKA_WEBHOOK_PORT = Number(process.env.PLANKA_WEBHOOK_PORT ?? '8089')
const PLANKA_WEBHOOK_TOKEN = process.env.PLANKA_WEBHOOK_TOKEN
const PUSH_DELAY_MS = Number(process.env.PLANKA_PUSH_DELAY_MS ?? process.env.PLANKA_DEBOUNCE_MS ?? '60000')
const THROTTLE_MS = Number(process.env.PLANKA_THROTTLE_MS ?? '300000')
const COMPACT_AFTER_IDLE_MS = Number(process.env.PLANKA_COMPACT_AFTER_IDLE_MS ?? '1800000')
const TMUX_TARGET = process.env.PLANKA_TMUX_TARGET ?? ''
const INJECT_TARGET = process.env.PLANKA_INJECT_TARGET ?? ''
const DISPATCH_TICK_MS = Number(process.env.PLANKA_DISPATCH_TICK_MS ?? '5000')
const COMPACT_TICK_MS = Number(process.env.PLANKA_COMPACT_TICK_MS ?? '60000')
const CATCHUP_MAX = Number(process.env.PLANKA_CATCHUP_MAX ?? '50')
const LOG_ALL_EVENTS = process.env.PLANKA_LOG_ALL_EVENTS === '1'

// Which webhook events get queued+forwarded. Defaults narrow to actionable
// notifications only; everything else (cardUpdate, commentCreate from
// non-mentions, userUpdate, etc.) is dropped at the receiver.
const FORWARDED_EVENTS = new Set(
  (process.env.PLANKA_FORWARD_EVENTS ?? 'notificationCreate')
    .split(',').map((s) => s.trim()).filter(Boolean),
)
const FORWARDED_NOTIFICATION_TYPES = new Set(
  (process.env.PLANKA_FORWARD_NOTIFICATION_TYPES ?? 'mentionInComment,addMemberToCard')
    .split(',').map((s) => s.trim()).filter(Boolean),
)

const HAVE_AUTH = !!PLANKA_TOKEN || (PLANKA_USERNAME && PLANKA_PASSWORD)
if (!PLANKA_URL || !HAVE_AUTH || PLANKA_BOARD_IDS.size === 0 || !PLANKA_WEBHOOK_TOKEN) {
  console.error(
    'Missing required config. Set PLANKA_URL, auth (PLANKA_TOKEN OR PLANKA_USERNAME+PLANKA_PASSWORD), ' +
    'PLANKA_BOARD_IDS (or PLANKA_BOARD_ID for single-board), and PLANKA_WEBHOOK_TOKEN in environment.',
  )
  process.exit(1)
}
if (!PLANKA_INSTANCE_NAME) {
  console.error('PLANKA_INSTANCE_NAME is required when watching multiple boards (set it to a short agent label, e.g. "myagent").')
  process.exit(1)
}

for (const [name, val] of [
  ['PLANKA_URL', PLANKA_URL],
  ['PLANKA_TOKEN', PLANKA_TOKEN ?? ''],
  ['PLANKA_USERNAME', PLANKA_USERNAME ?? ''],
  ['PLANKA_PASSWORD', PLANKA_PASSWORD ?? ''],
  ['PLANKA_BOARD_IDS', PLANKA_BOARD_IDS_RAW],
  ['PLANKA_WEBHOOK_TOKEN', PLANKA_WEBHOOK_TOKEN],
] as const) {
  if (val && val.includes('${')) {
    console.error(`${name} contains an unresolved \${...} placeholder; refusing to start. Set ${name} in the agent's .env.`)
    process.exit(1)
  }
}
if (PLANKA_WEBHOOK_TOKEN.length < 16) {
  console.error('PLANKA_WEBHOOK_TOKEN must be at least 16 characters. Generate with: openssl rand -hex 32')
  process.exit(1)
}

mkdirSync(join(STATE_DIR, PLANKA_INSTANCE_NAME), { recursive: true })
const SERVER_LOG = join(STATE_DIR, PLANKA_INSTANCE_NAME, 'server.log')

function logServer(msg: string): void {
  const line = `${new Date().toISOString()} ${msg}\n`
  try { appendFileSync(SERVER_LOG, line) } catch {}
  console.error(`[planka-channel] ${msg}`)
}

// ---------------------------------------------------------------------------
// Stop-hook watcher
// ---------------------------------------------------------------------------

const STOP_DIR = '/tmp/planka-stop'
mkdirSync(STOP_DIR, { recursive: true })

// The Stop hook drops a marker file named after the instance (was: board id).
// Multi-board agents share one instance name so the hook only needs one
// PLANKA_INSTANCE_NAME env var to know what to write.
const STOP_MARKER = PLANKA_INSTANCE_NAME

function setupStopWatcher(onStop: () => void): void {
  try {
    for (const f of readdirSync(STOP_DIR)) {
      if (f === STOP_MARKER) {
        try { rmSync(join(STOP_DIR, f)) } catch {}
      }
    }
  } catch {}
  watch(STOP_DIR, (_event, filename) => {
    if (filename !== STOP_MARKER) return
    const path = join(STOP_DIR, filename)
    try { statSync(path) } catch { return }
    try { rmSync(path) } catch {}
    onStop()
  })
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

const INSTRUCTIONS = `Planka events arrive as bundled <channel source="planka" ...> notifications,
one card at a time. Each bundle narrates the events that piled up on that
card during the push-delay window. After you finish handling a bundle, call
events.complete with one of the event_ids and a short outcome label
(replied, noop, deferred, error). The next bundle won't be pushed until
you've stopped AND the throttle window elapses.

Tools:
  - events.complete  — REQUIRED after handling each pushed bundle.
  - card.get / card.comment — read context, reply.
  - events.list_pending / events.claim — debug only; the server normally
    pushes events to you, you don't need to poll.

Don't comment unless the message is directed at you or actionable. Empty/
trivial replies are worse than silence.`

const mcp = new Server(
  { name: 'planka', version: '0.3.0' },
  {
    capabilities: {
      experimental: { 'claude/channel': {} },
      tools: {},
    },
    instructions: INSTRUCTIONS,
  },
)

const queue = new Queue(STATE_DIR, PLANKA_INSTANCE_NAME, PUSH_DELAY_MS)

const planka = new PlankaClient({
  url: PLANKA_URL,
  apiToken: PLANKA_TOKEN,
  username: PLANKA_USERNAME,
  password: PLANKA_PASSWORD,
  botUserIdOverride: PLANKA_BOT_USER_ID,
  boardIds: PLANKA_BOARD_IDS,
  webhookPort: PLANKA_WEBHOOK_PORT,
  webhookToken: PLANKA_WEBHOOK_TOKEN,
  forwardedEvents: FORWARDED_EVENTS,
  forwardedNotificationTypes: FORWARDED_NOTIFICATION_TYPES,
  logAllEvents: LOG_ALL_EVENTS,
  onEnvelope: (env) => queue.ingest(env),
  onListening: () => logServer(
    `webhook listener up on :${PLANKA_WEBHOOK_PORT}/webhook instance=${PLANKA_INSTANCE_NAME} `
    + `boards=[${[...PLANKA_BOARD_IDS].join(',')}] `
    + `push_delay=${PUSH_DELAY_MS}ms throttle=${THROTTLE_MS}ms `
    + `forward=[${[...FORWARDED_EVENTS].join(',')}] `
    + `notif_types=[${[...FORWARDED_NOTIFICATION_TYPES].join(',')}]`,
  ),
  onError: (msg) => logServer(msg),
})

planka.login()
  .then(async () => {
    const authMode = PLANKA_TOKEN ? 'token' : `password as ${PLANKA_USERNAME}`
    logServer(`auth ok via ${authMode} (bot=${planka.getBotUserId() ?? 'unknown'})`)
    if (CATCHUP_MAX > 0) {
      try {
        const n = await planka.catchupNotifications(CATCHUP_MAX)
        if (n > 0) logServer(`catchup: enqueued ${n} unread notification(s)`)
      } catch (err) {
        logServer(`catchup threw: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  })
  .catch((err) => logServer(`login failed (will retry on first REST call): ${err.message}`))

setupStopWatcher(() => {
  queue.noteStop()
  logServer('stop event received')
})

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'events.complete',
      description:
        'Mark the currently pushed bundle as done. Advances idempotency for every notification in the bundle, clears the card lock, appends an audit row, and unblocks the next push (after the throttle window).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          event_id: { type: 'string' as const, description: 'Any event_id or bundle_id from the pushed bundle' },
          outcome: { type: 'string' as const, description: 'One-token label: replied, noop, deferred, error, etc.' },
          note: { type: 'string' as const, description: 'Optional free-text context for the audit row' },
          last_comment_id_seen: { type: 'string' as const, description: 'Latest comment id observed on the card; carried forward for dedup' },
          priority: { type: 'string' as const, description: 'Audit priority tag: A (mentions), B (delegated), none' },
        },
        required: ['event_id', 'outcome'],
      },
    },
    {
      name: 'card.get',
      description: 'Fetch full Planka card detail by id (REST passthrough).',
      inputSchema: {
        type: 'object' as const,
        properties: { card_id: { type: 'string' as const } },
        required: ['card_id'],
      },
    },
    {
      name: 'card.comment',
      description: 'Post a comment back to a Planka card. Returns the new comment id.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          card_id: { type: 'string' as const },
          text: { type: 'string' as const },
        },
        required: ['card_id', 'text'],
      },
    },
    {
      name: 'events.list_pending',
      description:
        '[debug] List every pending bundle (snapshot of the in-memory queue). Push mode normally drives this without your help.',
      inputSchema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'events.claim',
      description:
        '[debug] Manually claim a bundle by event_id or bundle_id. Push mode normally calls this for you.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          event_id: { type: 'string' as const },
          lock_description: { type: 'string' as const },
        },
        required: ['event_id', 'lock_description'],
      },
    },
  ],
}))

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] }
}
function fail(message: string) {
  return { content: [{ type: 'text' as const, text: `error: ${message}` }], isError: true }
}

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = (req.params.arguments ?? {}) as Record<string, any>
  try {
    switch (req.params.name) {
      case 'events.complete': {
        if (!args.event_id || !args.outcome) return fail('event_id and outcome required')
        const r = queue.complete({
          event_id: args.event_id,
          outcome: args.outcome,
          note: args.note,
          last_comment_id_seen: args.last_comment_id_seen,
          priority: args.priority,
        })
        if (!r) return fail('no bundle found for event_id')
        logServer(`bundle ${r.bundle_id} completed (${r.events} events, outcome=${args.outcome})`)
        return ok({ ok: true, ...r })
      }
      case 'card.get': {
        if (!args.card_id) return fail('card_id required')
        return ok(await planka.getCard(args.card_id))
      }
      case 'card.comment': {
        if (!args.card_id || !args.text || !String(args.text).trim()) {
          return fail('card_id and non-empty text required')
        }
        const id = await planka.postComment(args.card_id, args.text)
        return ok({ comment_id: id })
      }
      case 'events.list_pending':
        return ok(queue.snapshot().pending)
      case 'events.claim': {
        if (!args.event_id || !args.lock_description) return fail('event_id and lock_description required')
        const b = queue.claim(args.event_id, args.lock_description)
        if (!b) return fail('not claimable')
        return ok(b)
      }
      default:
        return fail(`unknown tool: ${req.params.name}`)
    }
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err))
  }
})

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

function tmux(args: string[]): { code: number; stderr: string } {
  const r = spawnSync('tmux', args, { encoding: 'utf8' })
  return { code: r.status ?? -1, stderr: r.stderr ?? '' }
}

async function dispatchOne(): Promise<boolean> {
  if (!queue.pushAllowed(THROTTLE_MS)) return false
  const ready = queue.listReady()
  if (ready.length === 0) return false
  const bundle = ready[0]
  if (!queue.markPushed(bundle.bundle_id)) return false

  const body = narrateBundle(bundle)

  try {
    // Claude Code's channel notification schema requires every meta value
    // to be a string. Numbers and arrays trigger a Zod error and drop the
    // stdio connection. Stringify numbers + comma-join arrays.
    await mcp.notification({
      method: 'notifications/claude/channel',
      params: {
        content: body,
        meta: {
          source: 'planka',
          board_id: bundle.board_id ?? '',
          card_id: bundle.card_id ?? '',
          card_url: bundle.card_url ?? '',
          bundle_id: bundle.bundle_id,
          event_count: String(bundle.events.length),
          event_ids: bundle.events.map((e) => e.event_id).join(','),
          ts: new Date().toISOString(),
        },
      },
    })
  } catch (err) {
    logServer(`channel emit failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  // Hermes / TUI path: type the wrapped body into a tmux pane.
  if (INJECT_TARGET) {
    const r = tmux(['send-keys', '-t', INJECT_TARGET, body, 'Enter'])
    if (r.code !== 0) logServer(`tmux inject (${INJECT_TARGET}) failed: ${r.stderr.trim()}`)
  }

  logServer(`pushed bundle ${bundle.bundle_id} card=${bundle.card_id ?? '?'} events=${bundle.events.length}`)
  return true
}

setInterval(() => {
  void dispatchOne().catch((err) => logServer(`dispatch threw: ${err instanceof Error ? err.message : String(err)}`))
}, DISPATCH_TICK_MS)

// ---------------------------------------------------------------------------
// Compactor
// ---------------------------------------------------------------------------

let lastCompactAt = 0

function maybeCompact(): void {
  if (!TMUX_TARGET) return
  if (!queue.isIdle()) return
  const lastIngest = queue.lastIngestAt()
  const lastStop = queue.getState().last_stop_at
  // "Idle" reference = the most recent real activity (ingest or agent stop).
  // Excluding lastCompactAt is deliberate: if we included it, every successful
  // compact would reset the idle clock against itself and we'd refire every
  // COMPACT_AFTER_IDLE_MS forever even when nothing else happened.
  const now = Date.now()
  const ref = Math.max(lastIngest ?? 0, lastStop ?? 0, 0)
  if (ref === 0) return // never had any activity, don't compact
  if (now - ref < COMPACT_AFTER_IDLE_MS) return
  // Don't refire if we've already compacted and no NEW webhook ingest has
  // happened since. /compact itself triggers a Stop hook (the agent's
  // turn-end after compacting), so lastStop alone can't distinguish "real
  // new work" from "compact's own response". Ingest is the unambiguous
  // signal of new work; require that to re-arm.
  if (lastCompactAt > 0 && (lastIngest ?? 0) <= lastCompactAt) return

  const r1 = tmux(['send-keys', '-t', TMUX_TARGET, '/compact'])
  if (r1.code !== 0) {
    logServer(`compact: tmux send-keys (text) failed: ${r1.stderr.trim()}`)
    return
  }
  // Slight gap so the slash-command commits before Enter — same Ink-paste
  // safety the mattermost-channel inject path uses.
  setTimeout(() => {
    const r2 = tmux(['send-keys', '-t', TMUX_TARGET, 'Enter'])
    if (r2.code !== 0) {
      logServer(`compact: tmux send-keys (Enter) failed: ${r2.stderr.trim()}`)
      return
    }
    lastCompactAt = Date.now()
    logServer(`compact: sent /compact to ${TMUX_TARGET} (idle ${(now - ref) / 1000}s)`)
  }, 200)
}

setInterval(maybeCompact, COMPACT_TICK_MS)

// ---------------------------------------------------------------------------
// Connect
// ---------------------------------------------------------------------------

await mcp.connect(new StdioServerTransport())
planka.start()
