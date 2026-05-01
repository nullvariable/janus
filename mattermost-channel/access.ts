/**
 * Sender gating for the Mattermost channel plugin.
 * Maintains an allowlist of Mattermost user IDs that can push messages
 * into the Claude Code session.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

interface AccessState {
  allowFrom: string[]
  policy: 'open' | 'allowlist'
}

const STATE_DIR = process.env.MATTERMOST_STATE_DIR
  ?? join(homedir(), '.claude', 'channels', 'mattermost')

const ACCESS_FILE = join(STATE_DIR, 'access.json')

let state: AccessState = { allowFrom: [], policy: 'open' }

export function loadAccess(): AccessState {
  try {
    const raw = readFileSync(ACCESS_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    state = {
      allowFrom: Array.isArray(parsed.allowFrom) ? parsed.allowFrom : [],
      policy: parsed.policy === 'allowlist' ? 'allowlist' : 'open',
    }
  } catch {
    // No file or parse error — start with open policy
    state = { allowFrom: [], policy: 'open' }
  }
  return state
}

function saveAccess(): void {
  mkdirSync(STATE_DIR, { recursive: true })
  writeFileSync(ACCESS_FILE, JSON.stringify(state, null, 2) + '\n')
}

/** Check if a sender is allowed to push messages. */
export function isAllowed(userId: string): boolean {
  if (state.policy === 'open') return true
  return state.allowFrom.includes(userId)
}

/** Add a user ID to the allowlist. */
export function addUser(userId: string): void {
  if (!state.allowFrom.includes(userId)) {
    state.allowFrom.push(userId)
    saveAccess()
  }
}

/** Remove a user ID from the allowlist. */
export function removeUser(userId: string): void {
  state.allowFrom = state.allowFrom.filter(id => id !== userId)
  saveAccess()
}

/** Set the access policy. */
export function setPolicy(policy: 'open' | 'allowlist'): void {
  state.policy = policy
  saveAccess()
}

/** Get current access state (for debugging). */
export function getAccess(): Readonly<AccessState> {
  return state
}
