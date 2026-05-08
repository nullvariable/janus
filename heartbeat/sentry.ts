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

export function captureMessage(msg: string, tags?: Record<string, string>): void {
  if (!initialized) return
  Sentry.captureMessage(msg, { level: 'error', tags })
}

export async function flush(timeoutMs = 2000): Promise<void> {
  if (!initialized) return
  await Sentry.flush(timeoutMs)
}

export async function fatalAndExit(msg: string, tags?: Record<string, string>): Promise<never> {
  captureMessage(msg, tags)
  await flush(2000)
  process.exit(1)
}
