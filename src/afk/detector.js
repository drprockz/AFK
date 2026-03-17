// src/afk/detector.js
import { getState, setAfk, touchLastRequestTs } from './state.js'

/**
 * Checks if the user has been idle long enough to auto-enable AFK.
 * Updates last_request_ts unconditionally on every call.
 * Reads auto_afk_minutes from state file (not config.json).
 * @returns {void}
 */
export function checkAndAutoAfk() {
  const state = getState()
  const { auto_afk_minutes, afk, last_request_ts } = state

  // Conditions that skip the idle check (but still update timestamp):
  // - First invocation (last_request_ts === null)
  // - auto-AFK disabled (auto_afk_minutes === 0)
  // - already in AFK mode (afk === true)
  if (last_request_ts === null || auto_afk_minutes === 0 || afk) {
    touchLastRequestTs()
    return
  }

  const elapsed = Date.now() - last_request_ts
  if (elapsed > auto_afk_minutes * 60 * 1000) {
    const elapsedMinutes = Math.floor(elapsed / 60_000)
    setAfk(true)
    process.stderr.write(`afk: auto-AFK enabled after ${elapsedMinutes} minutes idle\n`)
  }

  touchLastRequestTs()
}
