import { test } from 'node:test'
import assert from 'node:assert'
import { notify } from '../src/notify/telegram.js'

const CONFIG = { telegramToken: 'TOKEN', telegramChatId: '12345' }
const REQ    = { tool: 'Bash', command: 'npm test', path: null, requestId: 'tg-req-id-001' }
const BASE   = 'https://api.telegram.org/botTOKEN'

function mockFetch(fn) {
  const orig = globalThis.fetch
  globalThis.fetch = fn
  return () => { globalThis.fetch = orig }
}

// Returns a minimal Telegram Bot API JSON response
function tgResp(result) {
  return new Response(JSON.stringify({ ok: true, result }), {
    status: 200, headers: { 'content-type': 'application/json' }
  })
}

// A callback_query update matching our requestId
function callbackUpdate(updateId, callbackData) {
  return { update_id: updateId, callback_query: { id: 'cb1', data: callbackData } }
}

test('approve callback → "allow"', async () => {
  let callCount = 0
  const restore = mockFetch(async (url) => {
    callCount++
    if (url.includes('getUpdates') && callCount === 1) return tgResp([])          // baseline
    if (url.includes('sendMessage'))                    return tgResp({ message_id: 1 }) // send
    if (url.includes('answerCallbackQuery'))            return tgResp(true)
    // poll: return matching callback
    return tgResp([callbackUpdate(100, `allow:${REQ.requestId}`)])
  })
  try {
    const result = await notify(CONFIG, REQ, 5000)
    assert.strictEqual(result, 'allow')
  } finally { restore() }
})

test('deny callback → "deny"', async () => {
  let callCount = 0
  const restore = mockFetch(async (url) => {
    callCount++
    if (url.includes('getUpdates') && callCount === 1) return tgResp([])
    if (url.includes('sendMessage'))                    return tgResp({ message_id: 1 })
    if (url.includes('answerCallbackQuery'))            return tgResp(true)
    return tgResp([callbackUpdate(100, `deny:${REQ.requestId}`)])
  })
  try {
    const result = await notify(CONFIG, REQ, 5000)
    assert.strictEqual(result, 'deny')
  } finally { restore() }
})

test('poll always empty → "timeout"', async () => {
  let callCount = 0
  const restore = mockFetch(async (url) => {
    callCount++
    if (url.includes('getUpdates') && callCount === 1) return tgResp([])
    if (url.includes('sendMessage'))                    return tgResp({ message_id: 1 })
    return tgResp([]) // always empty poll
  })
  try {
    const result = await notify(CONFIG, REQ, 150) // short waitMs
    assert.strictEqual(result, 'timeout')
  } finally { restore() }
})

test('sendMessage throws → "timeout", no throw', async () => {
  let callCount = 0
  const restore = mockFetch(async (url) => {
    callCount++
    if (url.includes('getUpdates') && callCount === 1) return tgResp([])
    throw new Error('network error')
  })
  try {
    const result = await notify(CONFIG, REQ, 5000)
    assert.strictEqual(result, 'timeout')
  } finally { restore() }
})

test('getUpdates (poll) throws → "timeout", no throw', async () => {
  let callCount = 0
  const restore = mockFetch(async (url) => {
    callCount++
    if (url.includes('getUpdates') && callCount === 1) return tgResp([])
    if (url.includes('sendMessage'))                    return tgResp({ message_id: 1 })
    throw new Error('poll failed') // poll throws
  })
  try {
    const result = await notify(CONFIG, REQ, 5000)
    assert.strictEqual(result, 'timeout')
  } finally { restore() }
})
