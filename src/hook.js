// src/hook.js
// Entry point — called by Claude Code on every PermissionRequest.
// Reads JSON from stdin, runs decision chain, writes behavior to stdout.
// Must always exit 0. Never hang beyond 30 seconds.

import { chain } from './engine/chain.js'
import { updateBaseline } from './store/history.js'

const HARD_DEADLINE_MS = 25_000

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
    process.stdout.write(JSON.stringify({ behavior: 'ask' }))
    process.exit(0)
  }

  try {
    const deadline = Date.now() + HARD_DEADLINE_MS
    const result = await Promise.race([
      chain(request, deadline),
      new Promise(resolve =>
        setTimeout(() => resolve({ behavior: 'ask', reason: 'timeout' }), HARD_DEADLINE_MS)
      )
    ])
    // Post-chain side effect: update anomaly baseline unconditionally
    try { updateBaseline(request) } catch { /* non-fatal */ }
    process.stdout.write(JSON.stringify({ behavior: result.behavior }))
    process.exit(0)
  } catch (err) {
    process.stderr.write(`afk error: ${err.message}\n`)
    process.stdout.write(JSON.stringify({ behavior: 'ask' }))
    process.exit(0)
  }
})
