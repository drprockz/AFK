// src/afk/state.js
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const stateDir = process.env.AFK_STATE_DIR ?? join(homedir(), '.claude', 'afk')
const statePath = join(stateDir, 'state.json')

/**
 * Reads the current state from disk, or returns a default state if not found.
 * @returns {object}
 * @private
 */
function readState() {
  if (!existsSync(statePath)) return defaultState()
  try {
    return JSON.parse(readFileSync(statePath, 'utf8'))
  } catch {
    return defaultState()
  }
}

/**
 * Writes state to disk.
 * @param {object} state
 * @private
 */
function writeState(state) {
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(statePath, JSON.stringify(state, null, 2))
}

/**
 * Returns the default state object.
 * @returns {object}
 * @private
 */
function defaultState() {
  return {
    afk: false,
    afk_since: null,
    afk_until: null,
    session_id: randomUUID(),
    auto_afk_minutes: 15,
    last_request_ts: null,
    digest: []
  }
}

/**
 * Returns true if AFK mode is currently on (and not expired).
 * Reads state file synchronously on each call — no daemon required.
 * If afk_until has passed, auto-resets AFK mode to off.
 * @returns {boolean}
 */
export function isAfk() {
  const state = readState()
  if (!state.afk) return false
  if (state.afk_until && Date.now() > state.afk_until) {
    // expired — auto-reset
    writeState({ ...state, afk: false, afk_since: null, afk_until: null })
    return false
  }
  return true
}

/**
 * Enables or disables AFK mode.
 * @param {boolean} on
 * @param {number} [durationMinutes] — if provided, auto-returns after this many minutes
 */
export function setAfk(on, durationMinutes) {
  const state = readState()
  writeState({
    ...state,
    afk: on,
    afk_since: on ? Date.now() : null,
    afk_until: on && durationMinutes ? Date.now() + durationMinutes * 60 * 1000 : null
  })
}

/**
 * Returns the current session UUID (stable for the life of the state file).
 * @returns {string}
 */
export function getSessionId() {
  return readState().session_id
}

/**
 * Appends one entry to the session digest (summary of auto-approved actions).
 * @param {object} entry
 */
export function appendDigest(entry) {
  const state = readState()
  writeState({ ...state, digest: [...(state.digest ?? []), entry] })
}

/**
 * Returns the full digest array and clears it from the state file.
 * @returns {object[]}
 */
export function getAndClearDigest() {
  const state = readState()
  const digest = state.digest ?? []
  writeState({ ...state, digest: [] })
  return digest
}

/**
 * Returns the full current state object. Read-only snapshot.
 * @returns {object}
 */
export function getState() {
  return readState()
}

/**
 * Updates last_request_ts to the current time.
 * MUST be read-modify-write — spreads current state, not defaultState.
 * Called by detector.js on every hook invocation.
 * @returns {void}
 */
export function touchLastRequestTs() {
  const state = readState()
  writeState({ ...state, last_request_ts: Date.now() })
}
