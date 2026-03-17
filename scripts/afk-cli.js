#!/usr/bin/env node
// scripts/afk-cli.js — invoked by /afk slash command via Claude's Bash tool
import { isAfk, setAfk, getAndClearDigest, getState } from '../src/afk/state.js'
import { getPendingItems, resolveItem } from '../src/store/queue.js'
import { buildDigest } from '../src/afk/digest.js'

/**
 * Parses a duration string like "30m", "2h", "1h30m" into minutes.
 * Returns null for unrecognised strings (which triggers usage print, not 'on').
 * @param {string} str
 * @returns {number|null} minutes, or null if not a valid duration
 */
function parseDuration(str) {
  const hours = Number(str.match(/(\d+)h/)?.[1] ?? 0)
  const mins  = Number(str.match(/(\d+)m/)?.[1] ?? 0)
  const total = hours * 60 + mins
  return total > 0 ? total : null
}

function formatTs(ms) {
  return new Date(ms).toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', hour12: false
  })
}

function formatDateTime(ms) {
  const d = new Date(ms)
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return `${date} ${formatTs(ms)}`
}

const [, , subcmd, ...rest] = process.argv

try {
  if (subcmd === 'on') {
    setAfk(true)
    process.stdout.write('AFK mode: ON\nClaude will handle safe permissions automatically.\n')

  } else if (subcmd === 'off') {
    if (!isAfk()) {
      process.stdout.write('AFK mode is already off.\n')
    } else {
      setAfk(false)
    }
    const entries = getAndClearDigest()
    const pendingItems = getPendingItems()
    const pendingCount = pendingItems.length
    process.stdout.write('AFK mode: OFF\n\n')
    process.stdout.write(buildDigest(entries, pendingCount) + '\n')
    if (pendingItems.length > 0) {
      process.stdout.write(`\nPending deferred actions (${pendingItems.length}):\n`)
      for (const item of pendingItems) {
        const label = item.command ?? item.path ?? item.tool
        process.stdout.write(`  [id=${item.id}] ${item.tool}: ${label}           ts: ${formatDateTime(item.ts)}\n`)
      }
      process.stdout.write('\nTo resolve: node scripts/afk-cli.js resolve <id> allow|deny\n')
    }

  } else if (subcmd === 'status') {
    const afkOn = isAfk()
    const pendingCount = getPendingItems().length
    if (afkOn) {
      const state = getState()
      const since = state.afk_since ? formatTs(state.afk_since) : '?'
      const until = state.afk_until ? `, auto-returns at ${formatTs(state.afk_until)}` : ''
      const autoApproved = (state.digest ?? []).filter(e => e.decision === 'allow').length
      process.stdout.write(`AFK mode: ON (since ${since}${until})\nPending deferred: ${pendingCount} actions\nSession digest: ${autoApproved} auto-approved since AFK started\n`)
    } else {
      const state = getState()
      const mins = state.auto_afk_minutes ?? 15
      const autoAfkStatus = mins === 0 ? 'disabled' : `enabled (triggers after ${mins} min idle)`
      process.stdout.write(`AFK mode: OFF\nPending deferred: ${pendingCount} actions\nAuto-AFK: ${autoAfkStatus}\n`)
    }

  } else if (subcmd === 'resolve') {
    const id = parseInt(rest[0], 10)
    const final = rest[1]
    if (isNaN(id) || !['allow', 'deny'].includes(final)) {
      process.stdout.write('Usage: node scripts/afk-cli.js resolve <id> allow|deny\n')
    } else {
      const updated = resolveItem(id, final)
      if (!updated) {
        process.stdout.write(`No pending item with id ${id}.\n`)
      } else {
        process.stdout.write(`Resolved [id=${id}]: ${final}.\n`)
      }
    }

  } else {
    // Check if it looks like a duration (30m, 2h, 1h30m)
    const mins = subcmd ? parseDuration(subcmd) : null
    if (mins !== null) {
      setAfk(true, mins)
      process.stdout.write(`AFK mode: ON for ${mins} minutes\n`)
    } else if (subcmd) {
      process.stdout.write('Usage: /afk [on|off|status|30m|2h|1h30m|resolve <id> allow|deny]\n')
    } else {
      // No arg: show status
      const afkOn = isAfk()
      const pendingCount = getPendingItems().length
      process.stdout.write(`AFK mode: ${afkOn ? 'ON' : 'OFF'}\nPending deferred: ${pendingCount} actions\n`)
    }
  }
} catch (err) {
  process.stderr.write(`afk-cli error: ${err.message}\n`)
  process.stdout.write(`Error running AFK command: ${err.message}\n`)
}
