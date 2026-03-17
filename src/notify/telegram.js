// src/notify/telegram.js

const TG = (token) => `https://api.telegram.org/bot${token}`

/**
 * Sends a Telegram message with Approve/Deny inline keyboard and long-polls for a
 * callback_query response.
 *
 * Flow:
 *   1. getUpdates (baseline) — capture highest update_id to ignore stale callbacks.
 *   2. sendMessage — deliver notification with inline keyboard.
 *   3. getUpdates (long-poll loop) — check for callback_query matching requestId.
 *   4. On match: answerCallbackQuery (best-effort), return "allow" or "deny".
 *   5. On timeout: return "timeout".
 *
 * Never throws — outer try/catch returns "timeout" on any error.
 *
 * @param {object} notifyConfig — { telegramToken, telegramChatId }
 * @param {object} req          — { tool, command, path, requestId }
 * @param {number} waitMs       — milliseconds to wait before returning "timeout"
 * @returns {Promise<"allow"|"deny"|"timeout">}
 */
export async function notify(notifyConfig, { tool, command, path, requestId }, waitMs) {
  try {
    const { telegramToken, telegramChatId } = notifyConfig
    const base = TG(telegramToken)

    // ── 1. Baseline update_id — skip all pending callbacks ────────────────────
    const baselineRes = await fetch(`${base}/getUpdates?limit=100`)
    const baseline = await baselineRes.json()
    const baselineUpdates = baseline.result ?? []
    let nextOffset = baselineUpdates.length > 0
      ? Math.max(...baselineUpdates.map(u => u.update_id)) + 1
      : 0

    // ── 2. Send message ───────────────────────────────────────────────────────
    await fetch(`${base}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: telegramChatId,
        text: `AFK – ${tool} request\n${command ?? path ?? tool}`,
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Approve', callback_data: `allow:${requestId}` },
            { text: '❌ Deny',    callback_data: `deny:${requestId}` }
          ]]
        }
      })
    })

    // ── 3. Long-poll loop ─────────────────────────────────────────────────────
    const deadline = Date.now() + waitMs
    while (Date.now() < deadline) {
      const remainingMs = deadline - Date.now()
      const pollSeconds = Math.max(1, Math.min(30, Math.floor(remainingMs / 1000) - 1))
      const params = new URLSearchParams({
        offset: nextOffset,
        timeout: pollSeconds,
        allowed_updates: JSON.stringify(['callback_query'])
      })
      const res = await fetch(`${base}/getUpdates?${params}`)
      const data = await res.json()
      const updates = data.result ?? []

      for (const update of updates) {
        if (update.update_id >= nextOffset) nextOffset = update.update_id + 1
        const cq = update.callback_query
        if (!cq) continue
        if (cq.data?.startsWith(`allow:${requestId}`)) {
          // Best-effort: dismiss spinner in Telegram UI
          fetch(`${base}/answerCallbackQuery`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ callback_query_id: cq.id })
          }).catch(() => {})
          return 'allow'
        }
        if (cq.data?.startsWith(`deny:${requestId}`)) {
          fetch(`${base}/answerCallbackQuery`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ callback_query_id: cq.id })
          }).catch(() => {})
          return 'deny'
        }
      }
    }

    return 'timeout'
  } catch {
    return 'timeout'
  }
}
