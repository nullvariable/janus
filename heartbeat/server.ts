#!/usr/bin/env bun
/**
 * Heartbeat MCP server for Claude Code.
 *
 * Periodically reads a file and injects its contents into the running
 * Claude Code session as a `notifications/claude/channel` event. Useful
 * for scheduled lightweight checks (e.g. due-date polls, status pings)
 * and for cron-style scheduled tasks (e.g. daily content generation).
 *
 * Two scheduling modes — set ONE or the other:
 *
 *   1) Interval + jitter (default):
 *      HEARTBEAT_INTERVAL_MINUTES  base interval, default 30
 *      HEARTBEAT_JITTER_MINUTES    ±n minutes uniform jitter, default 2
 *
 *   2) Wall-clock cron:
 *      HEARTBEAT_CRON              5-field cron expression, e.g. "0 5 * * 1-5"
 *                                  Supports: *, n, a-b, a,b,c, * /n
 *                                  No L/W/#/? extensions.
 *
 * Common env vars:
 *   HEARTBEAT_FILE   (required) absolute path to file to read
 *   HEARTBEAT_LABEL  source label in inbound meta, default "heartbeat"
 *
 * No tools exposed — heartbeat is one-way. The agent uses other registered
 * channels (e.g. mattermost.reply) to act on what it reads.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { readFileSync } from 'node:fs'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const HEARTBEAT_FILE = process.env.HEARTBEAT_FILE
const CRON = process.env.HEARTBEAT_CRON
const INTERVAL_MIN = Number(process.env.HEARTBEAT_INTERVAL_MINUTES ?? '30')
const JITTER_MIN = Number(process.env.HEARTBEAT_JITTER_MINUTES ?? '2')
const LABEL = process.env.HEARTBEAT_LABEL ?? 'heartbeat'

if (!HEARTBEAT_FILE) {
  console.error('Missing required HEARTBEAT_FILE env var')
  process.exit(1)
}

// In cron mode, interval/jitter are ignored. Otherwise validate them.
if (!CRON) {
  if (!Number.isFinite(INTERVAL_MIN) || INTERVAL_MIN <= 0) {
    console.error(`Invalid HEARTBEAT_INTERVAL_MINUTES: ${process.env.HEARTBEAT_INTERVAL_MINUTES}`)
    process.exit(1)
  }
  if (!Number.isFinite(JITTER_MIN) || JITTER_MIN < 0) {
    console.error(`Invalid HEARTBEAT_JITTER_MINUTES: ${process.env.HEARTBEAT_JITTER_MINUTES}`)
    process.exit(1)
  }
}

// ---------------------------------------------------------------------------
// Cron parser — minimal 5-field implementation
// ---------------------------------------------------------------------------

interface CronSpec {
  minute: Set<number>
  hour: Set<number>
  dom: Set<number>
  month: Set<number>
  dow: Set<number>
  domStar: boolean
  dowStar: boolean
}

function parseField(field: string, min: number, max: number): { values: Set<number>; isStar: boolean } {
  const values = new Set<number>()
  const isStar = field === '*'
  for (const part of field.split(',')) {
    let stepMatch = part.match(/^(.+)\/(\d+)$/)
    let base = stepMatch ? stepMatch[1] : part
    const step = stepMatch ? Number(stepMatch[2]) : 1
    if (!Number.isFinite(step) || step <= 0) throw new Error(`bad step in cron field: ${part}`)
    let lo: number
    let hi: number
    if (base === '*') {
      lo = min
      hi = max
    } else {
      const range = base.match(/^(\d+)(?:-(\d+))?$/)
      if (!range) throw new Error(`bad cron field token: ${part}`)
      lo = Number(range[1])
      hi = range[2] !== undefined ? Number(range[2]) : lo
    }
    if (lo < min || hi > max || lo > hi) {
      throw new Error(`cron value out of range [${min}-${max}]: ${part}`)
    }
    for (let v = lo; v <= hi; v += step) values.add(v)
  }
  return { values, isStar }
}

function parseCron(s: string): CronSpec {
  const fields = s.trim().split(/\s+/)
  if (fields.length !== 5) {
    throw new Error(`cron expression must have 5 fields, got ${fields.length}: "${s}"`)
  }
  const m = parseField(fields[0], 0, 59)
  const h = parseField(fields[1], 0, 23)
  const d = parseField(fields[2], 1, 31)
  const mo = parseField(fields[3], 1, 12)
  const w = parseField(fields[4], 0, 6) // 0 = Sunday
  return {
    minute: m.values,
    hour: h.values,
    dom: d.values,
    month: mo.values,
    dow: w.values,
    domStar: d.isStar,
    dowStar: w.isStar,
  }
}

// Walk minute-by-minute starting from `from + 1 minute`, return next match.
// Cron semantics: dom and dow are OR'd unless both are restricted (then AND
// would be wrong — vixie cron uses OR). We follow vixie: if both are
// restricted, match if EITHER matches.
function nextCronTick(spec: CronSpec, from: Date): Date {
  const next = new Date(from)
  next.setSeconds(0, 0)
  next.setMinutes(next.getMinutes() + 1)
  const limit = 367 * 24 * 60 // minutes in ~1 year
  for (let i = 0; i < limit; i++) {
    const minute = next.getMinutes()
    const hour = next.getHours()
    const dom = next.getDate()
    const month = next.getMonth() + 1
    const dow = next.getDay()
    const domMatch = spec.dom.has(dom)
    const dowMatch = spec.dow.has(dow)
    const dayMatch =
      spec.domStar && spec.dowStar
        ? true
        : spec.domStar
        ? dowMatch
        : spec.dowStar
        ? domMatch
        : domMatch || dowMatch
    if (
      spec.minute.has(minute) &&
      spec.hour.has(hour) &&
      spec.month.has(month) &&
      dayMatch
    ) {
      return next
    }
    next.setMinutes(next.getMinutes() + 1)
  }
  throw new Error(`no cron match within 1 year for spec`)
}

let cronSpec: CronSpec | null = null
if (CRON) {
  try {
    cronSpec = parseCron(CRON)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[heartbeat] failed to parse HEARTBEAT_CRON="${CRON}": ${msg}`)
    process.exit(1)
  }
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const INSTRUCTIONS = `Heartbeat events arrive as <channel source="heartbeat" file="..." ts="...">.
The content IS the prompt — follow the instructions in the file directly. Keep responses lightweight.`

const mcp = new Server(
  { name: 'heartbeat', version: '0.1.0' },
  {
    capabilities: {
      experimental: {
        'claude/channel': {},
      },
      tools: {},
    },
    instructions: INSTRUCTIONS,
  },
)

// Empty tool list — heartbeat is one-way, but Claude Code seems to require
// a ListTools handler for the server to register as a channel
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }))

await mcp.connect(new StdioServerTransport())

// ---------------------------------------------------------------------------
// Jittered timer
// ---------------------------------------------------------------------------

function nextDelayMs(): { delayMs: number; nextAt: Date } {
  if (cronSpec) {
    const nextAt = nextCronTick(cronSpec, new Date())
    return { delayMs: Math.max(1000, nextAt.getTime() - Date.now()), nextAt }
  }
  // Uniform jitter in [-JITTER_MIN, +JITTER_MIN]
  const jitter = (Math.random() * 2 - 1) * JITTER_MIN
  const minutes = Math.max(0.1, INTERVAL_MIN + jitter)
  const delayMs = minutes * 60 * 1000
  return { delayMs, nextAt: new Date(Date.now() + delayMs) }
}

async function tick(): Promise<void> {
  try {
    const content = readFileSync(HEARTBEAT_FILE!, 'utf8')
    await mcp.notification({
      method: 'notifications/claude/channel',
      params: {
        content,
        meta: {
          source: LABEL,
          file: HEARTBEAT_FILE,
          ts: new Date().toISOString(),
        },
      },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[heartbeat] tick failed: ${msg}`)
  }
}

function schedule(): void {
  const { delayMs, nextAt } = nextDelayMs()
  const mode = cronSpec ? `cron="${CRON}"` : `interval=${INTERVAL_MIN}±${JITTER_MIN}min`
  console.error(
    `[heartbeat] next tick at ${nextAt.toISOString()} (in ${(delayMs / 60000).toFixed(2)} min, ${mode}, file=${HEARTBEAT_FILE})`,
  )
  setTimeout(async () => {
    await tick()
    schedule()
  }, delayMs)
}

// First tick is delayed (no startup spam)
schedule()
