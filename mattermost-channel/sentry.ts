import * as Sentry from '@sentry/bun'

const dsn = process.env.GLITCHTIP_DSN
let initialized = false

export function initSentry(service: string): void {
  if (!dsn) return
  Sentry.init({
    dsn,
    environment: 'janus',
    release: process.env.JANUS_RELEASE ?? 'dev',
    initialScope: {
      tags: {
        agent: process.env.JANUS_AGENT ?? 'unknown',
        service,
        channel_id: process.env.MATTERMOST_CHANNEL_ID ?? 'unknown',
      },
    },
  })
  process.on('uncaughtException', (e) => Sentry.captureException(e))
  process.on('unhandledRejection', (e) => Sentry.captureException(e))
  initialized = true
}

export function captureException(err: unknown, tags?: Record<string, string>): void {
  if (!initialized) return
  Sentry.captureException(err, tags ? { tags } : undefined)
}

export async function captureApiError(
  url: string,
  status: number,
  body: string,
  tags?: Record<string, string>,
): Promise<void> {
  if (!initialized) return
  Sentry.captureMessage(`API error ${status} ${url}`, {
    level: 'error',
    tags: { ...(tags ?? {}), status: String(status), api: 'mattermost' },
    extra: { url, status, body: body.slice(0, 2000) },
  })
}

export async function flush(timeoutMs = 2000): Promise<void> {
  if (!initialized) return
  await Sentry.flush(timeoutMs)
}
