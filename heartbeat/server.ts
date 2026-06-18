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
import { type CronSpec, parseCron, nextCronTick, cronSearchSeed } from './cron.js'

initSentry('heartbeat')

async function fatal(msg: string, tags?: Record<string, string>): Promise<never> {
  console.error(msg)
  return fatalAndExit(msg, tags)
}

// ---------------------------------------------------------------------------
// Schedule type + loader
// ---------------------------------------------------------------------------

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
    // cronSearchSeed rounds `now` to the nearest minute so an early-firing
    // setTimeout (now still inside the prior minute) can't re-match the tick we
    // just fired and emit a duplicate ~60s later. See cron.ts for the full why.
    const nextAt = nextCronTick(s.cronSpec, cronSearchSeed(Date.now()))
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
