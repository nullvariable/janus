/**
 * Mattermost WebSocket + REST client for the channel plugin.
 * Connects via WS to receive real-time posted events, and exposes
 * a REST method to post messages back.
 */

export interface MattermostPost {
  id: string
  channel_id: string
  user_id: string
  message: string
  create_at: number
  root_id: string
}

export interface PostedEvent {
  post: MattermostPost
  sender_name: string
}

export type OnPosted = (event: PostedEvent) => void

interface MattermostClientOpts {
  url: string
  token: string
  channelId: string
  onPosted: OnPosted
  onConnected?: () => void
  onDisconnected?: () => void
}

export class MattermostClient {
  private url: string
  private token: string
  private channelId: string
  private onPosted: OnPosted
  private onConnected?: () => void
  private onDisconnected?: () => void

  private ws: WebSocket | null = null
  private wsSeq = 1
  private botUserId: string | null = null
  private reconnectDelay = 1000
  private maxReconnectDelay = 30000
  private shouldReconnect = true

  constructor(opts: MattermostClientOpts) {
    this.url = opts.url.replace(/\/+$/, '')
    this.token = opts.token
    this.channelId = opts.channelId
    this.onPosted = opts.onPosted
    this.onConnected = opts.onConnected
    this.onDisconnected = opts.onDisconnected
  }

  /** Fetch the bot's own user ID to filter echo messages. */
  async fetchBotUserId(): Promise<string> {
    const res = await fetch(`${this.url}/api/v4/users/me`, {
      headers: { Authorization: `Bearer ${this.token}` },
    })
    if (!res.ok) {
      throw new Error(`Failed to fetch bot user: ${res.status} ${await res.text()}`)
    }
    const user = (await res.json()) as { id: string }
    this.botUserId = user.id
    return user.id
  }

  /** Start the WebSocket connection. Call fetchBotUserId() first. */
  async connect(): Promise<void> {
    if (!this.botUserId) {
      await this.fetchBotUserId()
    }
    this.shouldReconnect = true
    this.openWebSocket()
  }

  /** Gracefully close the connection without reconnecting. */
  disconnect(): void {
    this.shouldReconnect = false
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
  }

  /** Post a message to a Mattermost channel. */
  async postMessage(channelId: string, message: string): Promise<void> {
    const res = await fetch(`${this.url}/api/v4/posts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ channel_id: channelId, message }),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Failed to post message: ${res.status} ${text}`)
    }
  }

  /** Add an emoji reaction to a post. */
  async addReaction(postId: string, emojiName: string): Promise<void> {
    if (!this.botUserId) await this.fetchBotUserId()
    const res = await fetch(`${this.url}/api/v4/reactions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        user_id: this.botUserId,
        post_id: postId,
        emoji_name: emojiName.replace(/^:|:$/g, ''),
      }),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Failed to add reaction: ${res.status} ${text}`)
    }
  }

  /** Send a typing indicator to a channel. */
  async sendTyping(channelId: string): Promise<void> {
    if (!this.botUserId) return
    try {
      await fetch(`${this.url}/api/v4/users/${this.botUserId}/typing`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ channel_id: channelId }),
      })
    } catch {
      // typing indicator is best-effort
    }
  }

  private openWebSocket(): void {
    const wsUrl = this.url.replace(/^http/, 'ws') + '/api/v4/websocket'
    const ws = new WebSocket(wsUrl)
    this.ws = ws

    ws.onopen = () => {
      // Authenticate
      ws.send(JSON.stringify({
        seq: this.wsSeq++,
        action: 'authentication_challenge',
        data: { token: this.token },
      }))
      this.reconnectDelay = 1000 // reset on successful connect
      this.onConnected?.()
    }

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(String(event.data))
        this.handleEvent(data)
      } catch {
        // ignore unparseable frames
      }
    }

    ws.onclose = () => {
      this.ws = null
      this.onDisconnected?.()
      if (this.shouldReconnect) {
        setTimeout(() => this.openWebSocket(), this.reconnectDelay)
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay)
      }
    }

    ws.onerror = () => {
      // onclose fires after onerror, so reconnect is handled there
    }
  }

  private handleEvent(data: any): void {
    if (data.event !== 'posted') return

    const channelId = data.broadcast?.channel_id
    if (channelId !== this.channelId) return

    let post: MattermostPost
    try {
      post = JSON.parse(data.data.post)
    } catch {
      return
    }

    // Filter out bot's own messages to prevent echo loops
    if (post.user_id === this.botUserId) return

    this.onPosted({
      post,
      sender_name: data.data.sender_name ?? '',
    })
  }
}
