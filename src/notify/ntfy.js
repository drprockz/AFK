// src/notify/ntfy.js

/**
 * Sends a push notification via ntfy and waits for an approve/deny response via SSE.
 *
 * Flow:
 *   1. POST notification to ntfy topic with Approve/Deny action buttons.
 *      When user taps a button, ntfy POSTs back to the response topic
 *      (body = "allow:<requestId>" or "deny:<requestId>"), publishing a message there.
 *   2. Subscribe to response topic SSE; parse JSON data lines; match requestId.
 *   3. Race against an AbortController timeout — return "timeout" if no match in waitMs.
 *
 * Never throws — outer try/catch returns "timeout" on any error.
 *
 * @param {object} notifyConfig — { ntfyServer, ntfyTopic }
 * @param {object} req          — { tool, command, path, requestId }
 * @param {number} waitMs       — milliseconds to wait before returning "timeout"
 * @returns {Promise<"allow"|"deny"|"timeout">}
 */
export async function notify(notifyConfig, { tool, command, path, requestId }, waitMs) {
  try {
    const { ntfyServer, ntfyTopic } = notifyConfig
    const responseTopic = `${ntfyServer}/${ntfyTopic}-response`
    const body = command ?? path ?? tool
    const ts = Math.floor(Date.now() / 1000)

    // ── 1. Send notification ──────────────────────────────────────────────────
    await fetch(`${ntfyServer}/${ntfyTopic}`, {
      method: 'POST',
      headers: {
        Title: `AFK – ${tool} request`,
        Priority: 'high',
        Tags: 'robot',
        Actions: `http, Approve, ${responseTopic}, method=POST, body=allow:${requestId}; http, Deny, ${responseTopic}, method=POST, body=deny:${requestId}`
      },
      body
    })

    // ── 2. Subscribe to SSE response with timeout ─────────────────────────────
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), waitMs)

    try {
      const res = await fetch(
        `${ntfyServer}/${ntfyTopic}-response/sse?since=${ts}`,
        { signal: controller.signal }
      )
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() // keep incomplete last line
        for (const line of lines) {
          if (!line.startsWith('data:')) continue
          try {
            const parsed = JSON.parse(line.slice(5).trim())
            if (parsed.message?.startsWith(`allow:${requestId}`)) {
              clearTimeout(timeoutId)
              return 'allow'
            }
            if (parsed.message?.startsWith(`deny:${requestId}`)) {
              clearTimeout(timeoutId)
              return 'deny'
            }
          } catch { /* skip unparseable lines */ }
        }
      }
    } catch {
      // AbortError (timeout), SSE fetch failure, or read error
    } finally {
      clearTimeout(timeoutId)
    }

    return 'timeout'
  } catch {
    return 'timeout'
  }
}
