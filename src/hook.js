// src/hook.js
// Entry point — called by Claude Code on every PermissionRequest.
// Reads JSON from stdin, runs decision chain, writes behavior to stdout.
// Must always exit 0. Never hang beyond 30 seconds.

import { chain } from './engine/chain.js'
import { updateBaseline } from './store/history.js'
import { ensureSession, updateSessionStats, addTokenEstimate, estimateTokens } from './store/session.js'

const HARD_DEADLINE_MS = 25_000

/**
 * Wraps a behavior string in the canonical PermissionRequest hook output format.
 * @param {string} behavior — 'allow' | 'deny' | 'ask'
 * @returns {string} JSON string
 */
function hookResponse(behavior) {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: { behavior }
    }
  })
}

let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => { input += chunk })
process.stdin.on('end', async () => {
  let request
  try {
    request = JSON.parse(input)
    if (!request?.tool) throw new Error('malformed input: missing tool')
  } catch (err) {
    process.stderr.write(`afk: parse error: ${err.message}\n`)
    process.stdout.write(hookResponse('ask'))
    process.exit(0)
  }

  // Auto-allow AFK's own CLI commands — no permission prompt needed.
  // Must be a strict prefix match: the command is EXACTLY "node <pluginRoot>/(hooks|scripts)/<filename>"
  // with no prefix pipeline or shell operators that could smuggle destructive commands past the check.
  if (request.tool === 'Bash' && request.input?.command) {
    const pluginRoot = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
    const cmd = request.input.command.trim()
    // Escape the path for use in a regex (handles spaces and special chars in home dirs)
    const escapedRoot = pluginRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const selfPattern = new RegExp(`^node\\s+${escapedRoot}/(hooks|scripts)/[^/\\s]+(\\.js)?(?:\\s+\\S*)*$`)
    if (selfPattern.test(cmd)) {
      process.stdout.write(hookResponse('allow'))
      process.exit(0)
    }
  }

  try {
    const deadline = Date.now() + HARD_DEADLINE_MS
    const result = await Promise.race([
      chain(request, deadline),
      new Promise(resolve =>
        setTimeout(() => resolve({ behavior: 'ask', reason: 'timeout' }), HARD_DEADLINE_MS)
      )
    ])
    // Post-chain side effect: update anomaly baseline only for approved requests.
    // Denied/deferred patterns should NOT inflate baseline counts — a consistently-denied
    // command must not escape anomaly detection by appearing "familiar".
    if (result.decision === 'allow') {
      try { updateBaseline(request) } catch { /* non-fatal */ }
    }
    try {
      ensureSession(request.session_id, request.cwd)
      updateSessionStats(request.session_id, result.decision ?? result.behavior ?? 'ask', result.source ?? 'chain')
      addTokenEstimate(request.session_id, estimateTokens(request.tool, request.input))
    } catch { /* non-fatal — session tracking must never block hook */ }
    process.stdout.write(hookResponse(result.behavior))
    process.exit(0)
  } catch (err) {
    process.stderr.write(`afk error: ${err.message}\n`)
    process.stdout.write(hookResponse('ask'))
    process.exit(0)
  }
})
