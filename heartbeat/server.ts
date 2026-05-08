#!/usr/bin/env bun
/**
 * Heartbeat MCP server for Claude Code.
 *
 * Periodically reads files and injects their contents into the running
 * Claude Code session as `notifications/claude/channel` events. One process
 * manages N schedules, each with its own file and cron/interval settings.
 *
 * Configuration: a JSON file pointed at by HEARTBEAT_CONFIGS_FILE. Schema:
 *
 *   [
 *     {
 *       "label": "create-content",                     // unique within file
 *       "file":  "/agents/marketing/.../create-content.md",
 *       "cron":  "0 5 * * 1-5",                         // OR interval/jitter (below)
 *       "interval_minutes": 30,                         // OR cron (above)
 *       "jitter_minutes": 2,
 *       "autopost": true,                               // optional, default false
 *       "marker": true                                  // optional, default false
 *     },
 *     ...
 *   ]
 *
 * Cron parser supports: *, n, a-b, a,b,c, * /n. No L/W/#/? extensions.
 *
 * No tools exposed — heartbeat is one-way. The agent uses other registered
 * channels (e.g. mattermost.reply) to act on what it reads.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { existsSync, readFileSync } from 'node:fs'
import { initSentry, captureException, fatalAndExit } from './sentry.js'

initSentry('heartbeat')

async function fatal(msg: string, tags?: Record<string, string>): Promise<never> {
  console.error(msg)
  return fatalAndExit(msg, tags)
}

// ---------------------------------------------------------------------------
// Schedule type + loader
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

interface Schedule {
  label: string
  file: string
  cronExpr?: string
  cronSpec?: CronSpec
  intervalMin?: number
  jitterMin?: number
  autopost: boolean
  marker: boolean
}

const CONFIGS_FILE = process.env.HEARTBEAT_CONFIGS_FILE
if (!CONFIGS_FILE) {
  await fatal('Missing required HEARTBEAT_CONFIGS_FILE env var', { reason: 'missing_env' })
}
if (!existsSync(CONFIGS_FILE)) {
  await fatal(`HEARTBEAT_CONFIGS_FILE does not exist: ${CONFIGS_FILE}`, { reason: 'missing_file' })
}

let raw: unknown
try {
  raw = JSON.parse(readFileSync(CONFIGS_FILE, 'utf8'))
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err)
  await fatal(`[heartbeat] failed to parse ${CONFIGS_FILE}: ${msg}`, { reason: 'parse_failed' })
}
if (!Array.isArray(raw)) {
  await fatal(`[heartbeat] ${CONFIGS_FILE} must contain a JSON array`, { reason: 'bad_format' })
}

// ---------------------------------------------------------------------------
// Cron parser — minimal 5-field implementation
// ---------------------------------------------------------------------------

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
// Cron semantics: dom and dow are OR'd unless both are restricted (vixie).
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

// ---------------------------------------------------------------------------
// Validate + normalize each entry
// ---------------------------------------------------------------------------

const schedules: Schedule[] = []
const seenLabels = new Set<string>()

for (const [i, entryRaw] of (raw as unknown[]).entries()) {
  if (!entryRaw || typeof entryRaw !== 'object') {
    await fatal(`[heartbeat] entry ${i}: must be an object`, { reason: 'bad_entry' })
  }
  const entry = entryRaw as Record<string, unknown>
  const label = entry.label
  const file = entry.file
  if (typeof label !== 'string' || !label) {
    await fatal(`[heartbeat] entry ${i}: missing/invalid "label"`, { reason: 'bad_label' })
  }
  if (seenLabels.has(label as string)) {
    await fatal(`[heartbeat] entry ${i}: duplicate label "${label}"`, { reason: 'dup_label' })
  }
  seenLabels.add(label as string)
  if (typeof file !== 'string' || !file) {
    await fatal(`[heartbeat] entry "${label}": missing/invalid "file"`, { reason: 'bad_file' })
  }
  if (!existsSync(file as string)) {
    await fatal(`[heartbeat] entry "${label}": file does not exist: ${file}`, { reason: 'missing_target_file' })
  }

  const cronExpr = typeof entry.cron === 'string' ? entry.cron : undefined
  const intervalMin = entry.interval_minutes !== undefined ? Number(entry.interval_minutes) : undefined
  const jitterMin = entry.jitter_minutes !== undefined ? Number(entry.jitter_minutes) : undefined

  if (cronExpr && intervalMin !== undefined) {
    await fatal(`[heartbeat] entry "${label}": set either "cron" OR "interval_minutes", not both`, { reason: 'conflicting_schedule' })
  }
  if (!cronExpr && intervalMin === undefined) {
    await fatal(`[heartbeat] entry "${label}": must set either "cron" or "interval_minutes"`, { reason: 'missing_schedule' })
  }

  let cronSpec: CronSpec | undefined
  if (cronExpr) {
    try {
      cronSpec = parseCron(cronExpr)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await fatal(`[heartbeat] entry "${label}": bad cron "${cronExpr}": ${msg}`, { reason: 'bad_cron' })
    }
  } else {
    if (!Number.isFinite(intervalMin) || (intervalMin as number) <= 0) {
      await fatal(`[heartbeat] entry "${label}": invalid interval_minutes: ${entry.interval_minutes}`, { reason: 'bad_interval' })
    }
    if (jitterMin !== undefined && (!Number.isFinite(jitterMin) || jitterMin < 0)) {
      await fatal(`[heartbeat] entry "${label}": invalid jitter_minutes: ${entry.jitter_minutes}`, { reason: 'bad_jitter' })
    }
  }

  schedules.push({
    label,
    file,
    cronExpr,
    cronSpec,
    intervalMin,
    jitterMin: jitterMin ?? 0,
    autopost: entry.autopost === true,
    marker: entry.marker === true,
  })
}

if (schedules.length === 0) {
  await fatal(`[heartbeat] ${CONFIGS_FILE} contains no schedules; nothing to do`, { reason: 'empty_config' })
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const INSTRUCTIONS = `Heartbeat events arrive as <channel source="heartbeat" label="..." file="..." ts="...">.
The "label" attribute identifies which schedule fired; the "file" content IS the prompt — follow the instructions in the file directly. Keep responses lightweight.`

const mcp = new Server(
  { name: 'heartbeat', version: '0.2.0' },
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
// Per-schedule timer chain
// ---------------------------------------------------------------------------

function nextDelayMs(s: Schedule): { delayMs: number; nextAt: Date } {
  if (s.cronSpec) {
    const nextAt = nextCronTick(s.cronSpec, new Date())
    // Floor to 60s in cron mode: cron's smallest unit is 1 minute, so any
    // "next tick is <60s away" is setTimeout drift firing the current tick
    // a hair early — without this the just-fired minute matches again.
    return { delayMs: Math.max(60_000, nextAt.getTime() - Date.now()), nextAt }
  }
  // Uniform jitter in [-jitterMin, +jitterMin]
  const jitter = (Math.random() * 2 - 1) * (s.jitterMin ?? 0)
  const minutes = Math.max(0.1, (s.intervalMin as number) + jitter)
  const delayMs = minutes * 60 * 1000
  return { delayMs, nextAt: new Date(Date.now() + delayMs) }
}

async function tick(s: Schedule): Promise<void> {
  try {
    const content = readFileSync(s.file, 'utf8')
    await mcp.notification({
      method: 'notifications/claude/channel',
      params: {
        content,
        meta: {
          source: 'heartbeat',
          label: s.label,
          file: s.file,
          ts: new Date().toISOString(),
        },
      },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[heartbeat] tick "${s.label}" failed: ${msg}`)
    captureException(err, { schedule_label: s.label, schedule_file: s.file })
  }
}

function schedule(s: Schedule): void {
  const { delayMs, nextAt } = nextDelayMs(s)
  const mode = s.cronSpec
    ? `cron="${s.cronExpr}"`
    : `interval=${s.intervalMin}±${s.jitterMin}min`
  console.error(
    `[heartbeat] "${s.label}" next tick at ${nextAt.toISOString()} (in ${(delayMs / 60000).toFixed(2)} min, ${mode}, file=${s.file})`,
  )
  setTimeout(async () => {
    await tick(s)
    schedule(s)
  }, delayMs)
}

// Start every schedule on its own chain. First tick is delayed (no startup spam).
console.error(`[heartbeat] loaded ${schedules.length} schedule(s) from ${CONFIGS_FILE}`)
for (const s of schedules) schedule(s)
