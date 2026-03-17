import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DEFAULTS = {
  notifications: {
    provider: null,
    ntfyServer: 'https://ntfy.sh',
    ntfyTopic: null,
    telegramToken: null,
    telegramChatId: null,
    timeout: 120
  }
}

/**
 * Reads ~/.claude/afk/config.json and returns merged config with defaults.
 * Never throws — returns defaults if file is missing or unparseable.
 * AFK_CONFIG_DIR env var overrides the directory (used in tests).
 * @returns {object}
 */
export function loadConfig() {
  const dir = process.env.AFK_CONFIG_DIR ?? join(homedir(), '.claude', 'afk')
  const filePath = join(dir, 'config.json')
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf8'))
    return {
      ...DEFAULTS,
      ...raw,
      notifications: {
        ...DEFAULTS.notifications,
        ...(raw.notifications ?? {})
      }
    }
  } catch {
    return { ...DEFAULTS, notifications: { ...DEFAULTS.notifications } }
  }
}
