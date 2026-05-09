/**
 * Planka webhook receiver + REST writer.
 *
 * Inbound: a Bun HTTP server listens on PLANKA_WEBHOOK_PORT for POSTs from
 * Planka. Planka's webhook payload (server/api/helpers/utils/send-webhooks.js)
 * is `{ event, data: { item, included }, prevData, user }` with an
 * `Authorization: Bearer <accessToken>` header where accessToken matches the
 * webhook's stored value. We validate the token, drop echoes from the bot
 * itself, build a per-event summary, and hand it to the queue.
 *
 * Outbound (REST writes): login with PLANKA_USERNAME/PASSWORD to get a
 * Bearer token, used for getCard and postComment.
 */

import type { Server } from 'bun'
import { newEventId, type EventEnvelope } from './queue.js'

export interface PlankaClientOpts {
  url: string
  /** If set, used as a Bearer token directly — no login. Username/password ignored. */
  apiToken?: string | null
  /** Used by the username/password login flow when apiToken is not set. */
  username?: string
  password?: string
  /**
   * Override for the "this is the bot's user id" used to filter inbound
   * notifications. Useful when auth is via a SHARED API key (e.g. an admin
   * key) but events should be filtered as if posted to a DIFFERENT user
   * (the agent's bot id). Without this, the server resolves bot user id
   * from /api/users/me, which reflects the API key's owner, not the agent's.
   */
  botUserIdOverride?: string | null
  /** Board IDs this instance subscribes to. One or more. */
  boardIds: Set<string>
  webhookPort: number
  webhookToken: string
  /** Webhook event names allowlisted for forwarding to the queue. Use `*` for all. */
  forwardedEvents: Set<string>
  /** For `notificationCreate`/`notificationUpdate`, also gate on item.type. Use `*` for all. */
  forwardedNotificationTypes: Set<string>
  onEnvelope: (env: EventEnvelope) => void
  onListening?: () => void
  onError?: (msg: string) => void
  logAllEvents?: boolean
}

interface PlankaWebhookBody {
  event: string
  data?: { item?: any; included?: any }
  prevData?: any
  user?: any
}

export class PlankaClient {
  private url: string
  private apiToken: string | null
  private username: string | null
  private password: string | null
  private boardIds: Set<string>
  private webhookPort: number
  private webhookToken: string
  private forwardedEvents: Set<string>
  private forwardedNotificationTypes: Set<string>
  private onEnvelope: (env: EventEnvelope) => void
  private onListening?: () => void
  private onError?: (msg: string) => void
  private logAllEvents: boolean

  private token: string | null = null
  private botUserId: string | null = null
  private server: Server | null = null

  constructor(opts: PlankaClientOpts) {
    this.url = opts.url.replace(/\/+$/, '')
    this.apiToken = opts.apiToken ?? null
    this.username = opts.username ?? null
    this.password = opts.password ?? null
    if (this.apiToken) this.token = this.apiToken
    if (opts.botUserIdOverride) this.botUserId = opts.botUserIdOverride
    this.boardIds = opts.boardIds
    this.webhookPort = opts.webhookPort
    this.webhookToken = opts.webhookToken
    this.forwardedEvents = opts.forwardedEvents
    this.forwardedNotificationTypes = opts.forwardedNotificationTypes
    this.onEnvelope = opts.onEnvelope
    this.onListening = opts.onListening
    this.onError = opts.onError
    this.logAllEvents = opts.logAllEvents ?? false
  }

  /**
   * Auth headers. Planka has two flavours:
   *  - `Authorization: Bearer <jwt>` for access tokens (login flow)
   *  - `x-api-key: <key>` for user API keys (POST /api/users/:id/api-key)
   * If apiToken was provided, sniff the format: JWTs start with "eyJ" and
   * have two dots; opaque random keys go to x-api-key.
   */
  private authHeaders(): Record<string, string> {
    if (this.apiToken) {
      const looksLikeJwt = this.apiToken.startsWith('eyJ') && this.apiToken.split('.').length === 3
      return looksLikeJwt
        ? { Authorization: `Bearer ${this.apiToken}` }
        : { 'x-api-key': this.apiToken }
    }
    if (this.token) return { Authorization: `Bearer ${this.token}` }
    return {}
  }

  /**
   * Authenticate. If apiToken was provided, skip login — just resolve bot
   * user id via /api/users/me. Otherwise POST username/password to mint a
   * JWT and use that.
   */
  async login(): Promise<string> {
    if (!this.apiToken) {
      if (!this.username || !this.password) {
        throw new Error('Planka auth: provide PLANKA_TOKEN (Bearer) or PLANKA_USERNAME+PLANKA_PASSWORD')
      }
      const res = await fetch(`${this.url}/api/access-tokens`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailOrUsername: this.username, password: this.password }),
      })
      if (!res.ok) {
        throw new Error(`Planka login failed: ${res.status} ${await res.text()}`)
      }
      const body = await res.json() as { item: string }
      this.token = body.item
    }

    // Skip the /api/users/me lookup if the override is already set —
    // otherwise we'd clobber it with the API key owner's id.
    if (!this.botUserId) {
      try {
        const me = await fetch(`${this.url}/api/users/me`, {
          headers: this.authHeaders(),
        })
        if (me.ok) {
          const json = await me.json() as { item?: { id?: string } }
          this.botUserId = json.item?.id ?? null
        }
      } catch {}
    }

    return this.token!
  }

  getBotUserId(): string | null {
    return this.botUserId
  }

  start(): void {
    this.server = Bun.serve({
      port: this.webhookPort,
      hostname: '0.0.0.0',
      fetch: (req) => this.handleRequest(req),
    })
    this.onListening?.()
  }

  stop(): void {
    if (this.server) {
      this.server.stop()
      this.server = null
    }
  }

  private async handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname === '/healthz' && req.method === 'GET') {
      return new Response('ok\n', { status: 200 })
    }
    if (url.pathname !== '/webhook') return new Response('not found\n', { status: 404 })
    if (req.method !== 'POST') return new Response('method not allowed\n', { status: 405 })

    const auth = req.headers.get('authorization') ?? ''
    const expected = `Bearer ${this.webhookToken}`
    if (!constantTimeEquals(auth, expected)) {
      this.onError?.(`webhook auth rejected (auth header len=${auth.length})`)
      return new Response('unauthorized\n', { status: 401 })
    }

    let body: PlankaWebhookBody
    try {
      body = await req.json() as PlankaWebhookBody
    } catch {
      return new Response('bad json\n', { status: 400 })
    }

    if (this.logAllEvents) {
      const summary = JSON.stringify({ event: body.event, item: body.data?.item ?? null }).slice(0, 600)
      this.onError?.(`event ${body.event} ${summary}`)
    }

    try {
      this.routeEvent(body)
    } catch (err) {
      this.onError?.(`route threw: ${err instanceof Error ? err.message : String(err)}`)
    }
    return new Response('ok\n', { status: 200 })
  }

  private routeEvent(body: PlankaWebhookBody): void {
    const item = body.data?.item
    if (!item) return

    const ev = body.event

    // Server-side allowlist: drop events the agent shouldn't see at all.
    // Default forwards only `notificationCreate` of types `mentionInComment`
    // and `addMemberToCard`. Everything else is silently dropped here so it
    // never enters the queue. LOG_ALL_EVENTS=1 still records inbound events
    // in server.log, so you can see what's being filtered.
    if (!this.forwardedEvents.has('*') && !this.forwardedEvents.has(ev)) return
    if (
      (ev === 'notificationCreate' || ev === 'notificationUpdate')
      && !this.forwardedNotificationTypes.has('*')
      && !this.forwardedNotificationTypes.has(item.type ?? '')
    ) return

    const actor = body.user
    const actorUserId: string | null = actor?.id ?? item.userId ?? null
    const actorName: string | null = actor?.name ?? actor?.username ?? null

    let cardId: string | null = null
    let notificationId: string | null = null
    let commentId: string | null = null
    let type = ev
    let resolvedBoardId: string | null = null

    switch (ev) {
      case 'notificationCreate':
      case 'notificationUpdate': {
        // Recipient must be the bot.
        if (this.botUserId && item.userId && item.userId !== this.botUserId) return
        // Notification carries its own boardId.
        const boardId = item.boardId ?? this.findBoardId(body)
        if (boardId && !this.boardIds.has(boardId)) return
        notificationId = item.id ?? null
        cardId = item.cardId ?? null
        resolvedBoardId = boardId ?? null
        type = 'notification'
        break
      }
      case 'commentCreate':
      case 'commentUpdate':
      case 'commentDelete': {
        // Echo filter: skip the bot's own comments coming back through.
        if (this.botUserId && item.userId === this.botUserId) return
        const boardId = this.findBoardId(body)
        if (boardId && !this.boardIds.has(boardId)) return
        commentId = item.id ?? null
        cardId = item.cardId ?? null
        resolvedBoardId = boardId ?? null
        type = ev
        break
      }
      case 'actionCreate': {
        if (this.botUserId && item.userId === this.botUserId) return
        const boardId = this.findBoardId(body)
        if (boardId && !this.boardIds.has(boardId)) return
        cardId = item.cardId ?? null
        resolvedBoardId = boardId ?? null
        type = item.type === 'commentCard' ? 'comment' : 'action'
        commentId = item.type === 'commentCard' ? item.id ?? null : null
        break
      }
      case 'cardCreate':
      case 'cardUpdate':
      case 'cardDelete':
      case 'cardLabelCreate':
      case 'cardLabelDelete':
      case 'cardMembershipCreate':
      case 'cardMembershipDelete': {
        if (this.botUserId && actorUserId === this.botUserId) return
        const boardId = item.boardId ?? this.findBoardId(body)
        if (boardId && !this.boardIds.has(boardId)) return
        cardId = item.id ?? item.cardId ?? null
        resolvedBoardId = boardId ?? null
        type = ev
        break
      }
      default:
        return
    }

    const cardName = this.findCardName(body, cardId)
    const cardUrl = cardId ? `${this.url}/cards/${cardId}` : null
    const summary = this.buildSummary(ev, item, actorName)

    this.onEnvelope({
      event_id: newEventId(),
      ts: new Date().toISOString(),
      type,
      // For multi-board instances, stamp the actual event's board_id rather
      // than a fixed value — narration and audit trail need it accurate.
      board_id: resolvedBoardId ?? (this.boardIds.size === 1 ? [...this.boardIds][0] : ''),
      card_id: cardId,
      notification_id: notificationId,
      comment_id: commentId,
      actor_user_id: actorUserId,
      actor_name: actorName,
      card_name: cardName,
      card_url: cardUrl,
      summary,
      raw: body,
    })
  }

  private findBoardId(body: PlankaWebhookBody): string | null {
    const item = body.data?.item
    if (item?.boardId) return item.boardId
    const cardId = item?.cardId
    if (cardId) {
      const card = body.data?.included?.cards?.find?.((c: any) => c.id === cardId)
      if (card?.boardId) return card.boardId
    }
    return null
  }

  private findCardName(body: PlankaWebhookBody, cardId: string | null): string | null {
    const item = body.data?.item
    if (!item) return null
    if (item.name && (item.id === cardId || (item.boardId && !item.cardId))) return item.name
    if (item.data?.card?.name) return item.data.card.name
    if (cardId) {
      const card = body.data?.included?.cards?.find?.((c: any) => c.id === cardId)
      if (card?.name) return card.name
    }
    return null
  }

  /** Compact one-liner the agent sees in the bundle narration. */
  private buildSummary(event: string, item: any, actorName: string | null): string {
    const trim = (s: any, n = 200) => {
      const t = String(s ?? '').replace(/\s+/g, ' ').trim()
      return t.length > n ? t.slice(0, n) + '…' : t
    }
    switch (event) {
      case 'commentCreate':
      case 'commentUpdate':
        return `"${trim(item.text)}"`
      case 'commentDelete':
        return `(comment deleted)`
      case 'notificationCreate':
      case 'notificationUpdate': {
        const text = item.data?.text ?? item.data?.card?.name ?? ''
        return `${item.type ?? 'notification'}${text ? `: "${trim(text)}"` : ''}`
      }
      case 'actionCreate': {
        const t = item.type
        if (t === 'moveCard') {
          const from = item.data?.fromList?.name ?? '?'
          const to = item.data?.toList?.name ?? '?'
          return `moveCard: ${from} → ${to}`
        }
        if (t === 'commentCard') return `"${trim(item.data?.text)}"`
        return `action ${t ?? '?'}`
      }
      case 'cardCreate':
        return `card created${item.name ? `: "${trim(item.name, 80)}"` : ''}`
      case 'cardUpdate':
        return `card updated${item.name ? `: "${trim(item.name, 80)}"` : ''}`
      case 'cardDelete':
        return `card deleted`
      case 'cardLabelCreate':
        return `label added`
      case 'cardLabelDelete':
        return `label removed`
      case 'cardMembershipCreate':
        return `member added`
      case 'cardMembershipDelete':
        return `member removed`
      default:
        return event
    }
  }

  /**
   * On boot, fetch unread notifications from Planka REST and re-emit any
   * the queue hasn't seen yet. Catches anything the webhook missed during
   * server downtime, before the webhook was registered, etc.
   *
   * Applies the same filters the webhook router would: bot recipient,
   * matching board, allowlisted notification type. The Queue's idempotency
   * check (processed_notifications) drops dupes silently.
   */
  async catchupNotifications(maxItems = 50): Promise<number> {
    if (!this.token) await this.login()
    let res: Response
    try {
      res = await fetch(`${this.url}/api/notifications`, {
        headers: this.authHeaders(),
      })
    } catch (err) {
      this.onError?.(`catchup fetch threw: ${err instanceof Error ? err.message : String(err)}`)
      return 0
    }
    if (!res.ok) {
      this.onError?.(`catchup fetch ${res.status}: ${(await res.text()).slice(0, 200)}`)
      return 0
    }
    const body = await res.json() as { items?: any[]; included?: any }
    const items = (body.items ?? []).slice()
    // Most-recent-first so the catchup limit picks up newest unread.
    items.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))

    let emitted = 0
    let scanned = 0
    let unreadForBot = 0
    for (const n of items) {
      scanned++
      if (n.isRead) continue
      if (this.botUserId && n.userId !== this.botUserId) continue
      unreadForBot++
      if (n.boardId && !this.boardIds.has(n.boardId)) continue
      if (!this.forwardedEvents.has('*') && !this.forwardedEvents.has('notificationCreate')) continue
      if (!this.forwardedNotificationTypes.has('*') && !this.forwardedNotificationTypes.has(n.type ?? '')) continue
      if (emitted >= maxItems) break

      const includedUser = body.included?.users?.find?.((u: any) => u.id === n.creatorUserId)
      const actorName: string | null = includedUser?.name ?? includedUser?.username ?? null
      const cardName = n.data?.card?.name
        ?? body.included?.cards?.find?.((c: any) => c.id === n.cardId)?.name
        ?? null

      this.onEnvelope({
        event_id: newEventId(),
        ts: n.createdAt ?? new Date().toISOString(),
        type: 'notification',
        board_id: n.boardId ?? (this.boardIds.size === 1 ? [...this.boardIds][0] : ''),
        card_id: n.cardId ?? null,
        notification_id: n.id ?? null,
        comment_id: null,
        actor_user_id: n.creatorUserId ?? null,
        actor_name: actorName,
        card_name: cardName,
        card_url: n.cardId ? `${this.url}/cards/${n.cardId}` : null,
        summary: this.buildSummary('notificationCreate', n, actorName),
        raw: { event: 'notificationCreate', data: { item: n, included: body.included }, user: includedUser ?? null, _source: 'catchup' },
      })
      emitted++
    }
    if (this.logAllEvents || emitted > 0) {
      this.onError?.(`catchup: scanned=${scanned} unread_for_bot=${unreadForBot} emitted=${emitted} (max=${maxItems})`)
    }
    return emitted
  }

  async getCard(cardId: string): Promise<unknown> {
    const res = await this.restWithRetry(`getCard ${cardId}`, () =>
      fetch(`${this.url}/api/cards/${cardId}`, { headers: this.authHeaders() }),
    )
    return res.json()
  }

  async postComment(cardId: string, text: string): Promise<string> {
    const res = await this.restWithRetry('postComment', () =>
      fetch(`${this.url}/api/cards/${cardId}/comments`, {
        method: 'POST',
        headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      }),
    )
    const body = await res.json() as { item?: { id?: string } }
    return body.item?.id ?? ''
  }

  /**
   * REST with auto-retry on 401: JWT-auth (username/password login flow) can
   * re-mint a fresh token and retry once. API-key auth can't refresh — a 401
   * there means the key was rotated out-of-band and needs replacing in the
   * agent's env.
   */
  private async restWithRetry(label: string, send: () => Promise<Response>): Promise<Response> {
    if (!this.token) await this.login()
    let res = await send()
    if (res.status === 401 && !this.apiToken && this.username && this.password) {
      this.onError?.(`${label}: 401 — refreshing JWT and retrying`)
      this.token = null
      await this.login()
      res = await send()
    }
    if (!res.ok) {
      throw new Error(`${label}: ${res.status} ${(await res.text()).slice(0, 200)}`)
    }
    return res
  }
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}
