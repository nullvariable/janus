import { test, expect } from 'bun:test'
import { parseCron, nextCronTick, cronSearchSeed } from './cron.js'

const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const MIN_MS = 60_000

// 2026-06-01 is a Monday. Monday 04:00 local — the monday-recap target.
const mondayRecap = parseCron('0 4 * * 1')
const boundary = new Date(2026, 5, 1, 4, 0, 0, 0)

test('boundary is actually a Monday', () => {
  expect(boundary.getDay()).toBe(1)
})

// The regression: when setTimeout fires the tick a hair EARLY, `now` is still in
// the prior minute (03:59:59.8). Searching from raw `now` re-matches the same
// 04:00 tick, producing a duplicate ~60s later. This is the bug the agent saw.
test('raw `now` on an early fire re-matches the just-fired tick (documents the bug)', () => {
  const earlyNow = new Date(boundary.getTime() - 200) // 03:59:59.800
  const buggy = nextCronTick(mondayRecap, earlyNow)
  expect(buggy.getTime()).toBe(boundary.getTime()) // duplicate — same 04:00 tick
})

// The fix: seed the search from `now` rounded to the nearest minute, so an early
// fire collapses onto the 04:00 minute it belongs to and the next match is a week
// out — no duplicate.
test('early fire: rounded seed skips the just-fired tick to next week', () => {
  const earlyNow = boundary.getTime() - 200
  const next = nextCronTick(mondayRecap, cronSearchSeed(earlyNow))
  expect(next.getTime()).not.toBe(boundary.getTime())
  expect(next.getTime()).toBe(boundary.getTime() + WEEK_MS)
})

test('on-time fire: next match is a week out', () => {
  const onTime = boundary.getTime() + 50
  const next = nextCronTick(mondayRecap, cronSearchSeed(onTime))
  expect(next.getTime()).toBe(boundary.getTime() + WEEK_MS)
})

test('late fire: next match is a week out', () => {
  const late = boundary.getTime() + 30_000 // 04:00:30
  const next = nextCronTick(mondayRecap, cronSearchSeed(late))
  expect(next.getTime()).toBe(boundary.getTime() + WEEK_MS)
})

// Guard against over-correction: rounding must NOT skip a legitimately-adjacent
// tick. An every-minute cron, fired on time, must advance by exactly one minute.
test('every-minute cron is not skipped by the rounded seed', () => {
  const everyMinute = parseCron('* * * * *')
  const t = new Date(2026, 5, 1, 4, 0, 0, 0).getTime()
  const next = nextCronTick(everyMinute, cronSearchSeed(t + 40)) // fired 0.04s late
  expect(next.getTime()).toBe(t + MIN_MS) // 04:01, not 04:02
})
