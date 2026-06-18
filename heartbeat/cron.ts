/**
 * Pure cron parsing + next-tick computation for the heartbeat scheduler.
 *
 * Extracted from server.ts so it can be unit-tested without the MCP/stdio
 * bootstrap side effects. No I/O, no clock reads except where a `now` is
 * passed in explicitly.
 *
 * Cron parser supports: *, n, a-b, a,b,c, * /n. No L/W/#/? extensions.
 */

export interface CronSpec {
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

export function parseCron(s: string): CronSpec {
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
export function nextCronTick(spec: CronSpec, from: Date): Date {
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

// Seed point for the next-tick search after a tick fires. setTimeout can fire a
// hair early (drift over a multi-day sleep), leaving `now` inside the prior
// minute (e.g. 03:59:59.8 for an 04:00 tick); searching from raw `now` would
// re-match that same minute and fire a duplicate ~60s later. Rounding to the
// nearest minute collapses early and late fires onto the one logical minute they
// belong to, so the search starts strictly after the tick we just fired —
// without skipping adjacent ticks the way a fixed +60s offset would.
export function cronSearchSeed(nowMs: number): Date {
  return new Date(Math.round(nowMs / 60_000) * 60_000)
}
