// src/notify/notify.js

import * as ntfy     from './ntfy.js'
import * as telegram from './telegram.js'

/**
 * Dispatcher: routes to the configured notification provider and returns the result.
 * Returns "skip" immediately if no provider is configured or provider is unknown.
 * Returns "timeout" if deadline is too close.
 * Never throws — outer try/catch returns "skip" on any error.
 *
 * @param {object} config   — full config object (from loadConfig())
 * @param {object} req      — { tool, command, path, requestId }
 * @param {number} deadline — chain deadline Unix ms timestamp
 * @returns {Promise<"allow"|"deny"|"timeout"|"skip">}
 */
export async function notify(config, req, deadline) {
  try {
    const nc = config.notifications
    const provider = nc?.provider

    if (!provider) return 'skip'

    const waitMs = Math.min(
      (nc.timeout ?? 120) * 1000,
      deadline - Date.now() - 2000  // always leave 2s buffer for chain teardown
    )
    if (waitMs <= 0) return 'timeout'

    if (provider === 'ntfy')     return await ntfy.notify(nc, req, waitMs)
    if (provider === 'telegram') return await telegram.notify(nc, req, waitMs)

    return 'skip' // unknown provider
  } catch {
    return 'skip'
  }
}
