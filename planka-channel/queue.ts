/**
 * On-disk event queue + idempotency state for planka-channel.
 *
 * Push-mode design: events for the same card collect into a Bundle during a
 * PUSH_DELAY window. The dispatcher picks the oldest ready bundle across all
 * cards and emits it as one channel notification. While a card has an
 * in-flight bundle (pushed, awaiting completion), new events for that card
 * collect into a NEW bundle that won't dispatch until the in-flight one
 * completes.
 *
 * Files (per-board, under ${PLANKA_STATE_DIR}/<board_id>/):
 *  - queue.jsonl  — append-only ingest log; one line per webhook event.
 *  - state.json   — processed_notifications, per-card processed_actions,
 *                   last_stop_at, last_push_at. Atomic-rename writes.
 *  - audit.jsonl  — one row per completed bundle.
 *
 * In-memory only:
 *  - pending bundles. A restart loses them. queue.jsonl preserves the audit
 *    trail; agents recover via Planka's notification list.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

export interface EventEnvelope {
  event_id: string
  ts: string
  type: string
  board_id: string
  card_id: string | null
  notification_id: string | null
  comment_id: string | null
  actor_user_id: string | null
  actor_name: string | null
  card_name: string | null
  card_url: string | null
  summary: string
  raw: unknown
}

export interface BundleEvent {
  event_id: string
  ts: string
  type: string
  notification_id: string | null
  comment_id: string | null
  actor_user_id: string | null
  actor_name: string | null
  summary: string
}

export interface PendingBundle {
  bundle_id: string
  card_id: string | null
  card_name: string | null
  card_url: string | null
  events: BundleEvent[]
  ready_at: number
  pushed_at: number | null
}

interface PerCardState {
  last_action_ts: string | null
  last_comment_id_seen: string | null
  in_flight: string | null
}

export interface QueueState {
  processed_notifications: string[]
  processed_actions: Record<string, PerCardState>
  last_event_id_acked: string | null
  last_stop_at: number | null
  last_push_at: number | null
}

const DEFAULT_PUSH_DELAY_MS = Number(
  process.env.PLANKA_PUSH_DELAY_MS ?? process.env.PLANKA_DEBOUNCE_MS ?? '60000',
)

export class Queue {
  private dir: string
  private statePath: string
  private queuePath: string
  private auditPath: string
  private state: QueueState
  private pending: PendingBundle[] = []
  private pushDelayMs: number

  constructor(stateDir: string, boardId: string, pushDelayMs = DEFAULT_PUSH_DELAY_MS) {
    this.dir = join(stateDir, boardId)
    mkdirSync(this.dir, { recursive: true })
    this.statePath = join(this.dir, 'state.json')
    this.queuePath = join(this.dir, 'queue.jsonl')
    this.auditPath = join(this.dir, 'audit.jsonl')
    this.pushDelayMs = pushDelayMs
    this.state = this.loadState()
    this.clearStaleInFlight()
  }

  private loadState(): QueueState {
    if (!existsSync(this.statePath)) {
      return {
        processed_notifications: [],
        processed_actions: {},
        last_event_id_acked: null,
        last_stop_at: null,
        last_push_at: null,
      }
    }
    try {
      const raw = JSON.parse(readFileSync(this.statePath, 'utf8'))
      return {
        processed_notifications: raw.processed_notifications ?? [],
        processed_actions: raw.processed_actions ?? {},
        last_event_id_acked: raw.last_event_id_acked ?? null,
        last_stop_at: raw.last_stop_at ?? null,
        last_push_at: raw.last_push_at ?? null,
      }
    } catch (err) {
      console.error(`[planka-channel] state.json corrupt, starting fresh: ${err}`)
      return {
        processed_notifications: [],
        processed_actions: {},
        last_event_id_acked: null,
        last_stop_at: null,
        last_push_at: null,
      }
    }
  }

  private saveState(): void {
    const tmp = this.statePath + '.tmp'
    writeFileSync(tmp, JSON.stringify(this.state, null, 2))
    renameSync(tmp, this.statePath)
  }

  /**
   * On boot, clear any in_flight locks left over from a previous run. The
   * agent state across restart is unreliable; better to risk re-delivering a
   * stuck bundle than to deadlock the card forever. Bundles that were already
   * pushed but not completed are LOST (in-memory only) — that's a known v1
   * trade-off documented in the README.
   */
  private clearStaleInFlight(): void {
    let cleared = 0
    for (const cardId of Object.keys(this.state.processed_actions)) {
      const s = this.state.processed_actions[cardId]
      if (s.in_flight) {
        s.in_flight = null
        cleared++
      }
    }
    if (cleared > 0) {
      console.error(`[planka-channel] cleared ${cleared} stale in_flight lock(s) on boot`)
      this.saveState()
    }
  }

  /**
   * Ingest a fresh event. Appends to queue.jsonl, then attaches it to a
   * bundle: either the latest non-pushed bundle for the card (extending its
   * ready_at), or a new bundle.
   */
  ingest(env: EventEnvelope): void {
    if (env.notification_id && this.state.processed_notifications.includes(env.notification_id)) {
      return
    }
    appendFileSync(this.queuePath, JSON.stringify(env) + '\n')

    const be: BundleEvent = {
      event_id: env.event_id,
      ts: env.ts,
      type: env.type,
      notification_id: env.notification_id,
      comment_id: env.comment_id,
      actor_user_id: env.actor_user_id,
      actor_name: env.actor_name,
      summary: env.summary,
    }

    // Find the latest open bundle for this card (open = not yet pushed).
    // We scan in reverse so the most recent bundle wins.
    let target: PendingBundle | null = null
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const b = this.pending[i]
      if (b.card_id === env.card_id && b.pushed_at === null) {
        target = b
        break
      }
    }

    const ready_at = Date.now() + this.pushDelayMs
    if (target) {
      target.events.push(be)
      target.ready_at = ready_at
      // Refresh card-level metadata when we learn it from later events
      if (env.card_name && !target.card_name) target.card_name = env.card_name
      if (env.card_url && !target.card_url) target.card_url = env.card_url
    } else {
      this.pending.push({
        bundle_id: newEventId(),
        card_id: env.card_id,
        card_name: env.card_name,
        card_url: env.card_url,
        events: [be],
        ready_at,
        pushed_at: null,
      })
    }
  }

  /** Bundles whose push-delay has elapsed and whose card has no in-flight lock. */
  listReady(): PendingBundle[] {
    const now = Date.now()
    const out: PendingBundle[] = []
    for (const b of this.pending) {
      if (b.pushed_at !== null) continue
      if (b.ready_at > now) continue
      const lock = b.card_id ? this.state.processed_actions[b.card_id]?.in_flight : null
      if (lock) continue
      out.push(b)
    }
    out.sort((a, b) => a.ready_at - b.ready_at)
    return out
  }

  /** Mark a bundle as dispatched. Sets pushed_at and the card's in_flight. */
  markPushed(bundleId: string): PendingBundle | null {
    const b = this.pending.find((x) => x.bundle_id === bundleId)
    if (!b) return null
    if (b.pushed_at !== null) return null
    b.pushed_at = Date.now()
    if (b.card_id) {
      const s = this.state.processed_actions[b.card_id] ?? {
        last_action_ts: null,
        last_comment_id_seen: null,
        in_flight: null,
      }
      s.in_flight = b.bundle_id
      this.state.processed_actions[b.card_id] = s
    }
    this.state.last_push_at = b.pushed_at
    this.saveState()
    return b
  }

  /** Note that the agent's turn finished — used by the throttle gate. */
  noteStop(): void {
    this.state.last_stop_at = Date.now()
    this.saveState()
  }

  /**
   * Push gate: when may the next bundle dispatch?
   *  - First push ever: allowed.
   *  - Otherwise: a Stop must have fired at or after the last push, AND at
   *    least throttleMs has elapsed since that Stop.
   * Uses `>=` against last_push_at so a Stop landing in the same ms (fast
   * synchronous tests) still counts.
   */
  pushAllowed(throttleMs: number): boolean {
    const lp = this.state.last_push_at
    const ls = this.state.last_stop_at
    if (lp === null) return true
    if (ls === null || ls < lp) return false
    return Date.now() - ls >= throttleMs
  }

  /** True if no card has an in-flight lock and no pending bundles exist. */
  isIdle(): boolean {
    if (this.pending.length > 0) return false
    for (const cardId of Object.keys(this.state.processed_actions)) {
      if (this.state.processed_actions[cardId].in_flight) return false
    }
    return true
  }

  /** Time of the most recent ingest (used by the compactor's idle check). */
  lastIngestAt(): number | null {
    let latest: number | null = null
    for (const b of this.pending) {
      for (const e of b.events) {
        const t = Date.parse(e.ts)
        if (!Number.isNaN(t) && (latest === null || t > latest)) latest = t
      }
    }
    return latest
  }

  /**
   * Find a pending bundle by either bundle_id or any contained event_id.
   * Lets the agent reference an event id from the narration.
   */
  findBundle(idOrEventId: string): PendingBundle | null {
    for (const b of this.pending) {
      if (b.bundle_id === idOrEventId) return b
      if (b.events.some((e) => e.event_id === idOrEventId)) return b
    }
    return null
  }

  /** Debug-only manual claim. Push-mode normally calls markPushed() instead. */
  claim(idOrEventId: string, lockDescription: string): PendingBundle | null {
    const b = this.findBundle(idOrEventId)
    if (!b) return null
    if (b.pushed_at !== null) return null
    if (Date.now() < b.ready_at) return null
    if (b.card_id) {
      const s = this.state.processed_actions[b.card_id]
      if (s?.in_flight) return null
    }
    b.pushed_at = Date.now()
    if (b.card_id) {
      const s = this.state.processed_actions[b.card_id] ?? {
        last_action_ts: null,
        last_comment_id_seen: null,
        in_flight: null,
      }
      s.in_flight = `${b.bundle_id}:${lockDescription}`
      this.state.processed_actions[b.card_id] = s
    }
    this.state.last_push_at = b.pushed_at
    this.saveState()
    return b
  }

  /**
   * Mark a bundle done. Advances idempotency for ALL notification_ids in the
   * bundle, clears the card's in_flight, removes the bundle from pending,
   * appends one audit row.
   */
  complete(opts: {
    event_id: string
    outcome: string
    note?: string
    last_comment_id_seen?: string
    priority?: string
  }): { bundle_id: string; events: number } | null {
    const b = this.findBundle(opts.event_id)
    if (!b) return null

    for (const e of b.events) {
      if (e.notification_id && !this.state.processed_notifications.includes(e.notification_id)) {
        this.state.processed_notifications.push(e.notification_id)
      }
    }
    if (this.state.processed_notifications.length > 5000) {
      this.state.processed_notifications = this.state.processed_notifications.slice(-5000)
    }

    if (b.card_id) {
      const s = this.state.processed_actions[b.card_id] ?? {
        last_action_ts: null,
        last_comment_id_seen: null,
        in_flight: null,
      }
      s.last_action_ts = new Date().toISOString()
      s.in_flight = null
      if (opts.last_comment_id_seen) s.last_comment_id_seen = opts.last_comment_id_seen
      this.state.processed_actions[b.card_id] = s
    }

    this.state.last_event_id_acked = b.events[b.events.length - 1]?.event_id ?? b.bundle_id
    this.saveState()

    const idx = this.pending.indexOf(b)
    if (idx >= 0) this.pending.splice(idx, 1)

    appendFileSync(
      this.auditPath,
      JSON.stringify({
        ts: new Date().toISOString(),
        priority: opts.priority ?? 'none',
        card_id: b.card_id,
        card_url: b.card_url,
        bundle_id: b.bundle_id,
        event_count: b.events.length,
        notification_ids: b.events.map((e) => e.notification_id).filter(Boolean),
        types: b.events.map((e) => e.type),
        outcome: opts.outcome,
        note: opts.note ?? '',
      }) + '\n',
    )

    return { bundle_id: b.bundle_id, events: b.events.length }
  }

  isNotificationProcessed(notificationId: string): boolean {
    return this.state.processed_notifications.includes(notificationId)
  }

  getState(): QueueState {
    return this.state
  }

  /** Snapshot for debug / introspection tools. */
  snapshot(): { pending: PendingBundle[]; state: QueueState } {
    return { pending: this.pending.slice(), state: this.state }
  }
}

export function newEventId(): string {
  return randomBytes(8).toString('hex')
}

/** Render a bundle as the channel-notification body the agent sees. */
export function narrateBundle(bundle: PendingBundle, boardId: string): string {
  const cardLabel = bundle.card_name ? `"${bundle.card_name}"` : `card ${bundle.card_id ?? '(unknown)'}`
  const header = bundle.events.length === 1
    ? `1 event on ${cardLabel}:`
    : `${bundle.events.length} events on ${cardLabel}:`
  const lines = bundle.events.map((e) => {
    const t = e.ts.slice(11, 19)
    const who = e.actor_name ?? e.actor_user_id ?? 'unknown'
    return `  [${t}] ${e.type} by ${who}: ${e.summary}`
  })
  const meta = [
    `source="planka"`,
    `board_id="${boardId}"`,
    `bundle_id="${bundle.bundle_id}"`,
    `card_id="${bundle.card_id ?? ''}"`,
    `event_count="${bundle.events.length}"`,
    bundle.card_url ? `card_url="${bundle.card_url}"` : null,
    `ts="${new Date().toISOString()}"`,
  ].filter(Boolean).join(' ')
  return `<channel ${meta}>\n${header}\n${lines.join('\n')}\n</channel>`
}
