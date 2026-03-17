import { test } from 'node:test'
import assert from 'node:assert'
import { notify } from '../src/notify/notify.js'

function mockFetch(fn) {
  const orig = globalThis.fetch
  globalThis.fetch = fn
  return () => { globalThis.fetch = orig }
}

// A minimal "ntfy allow" mock: POST → ok, SSE → allow event
function ntfyAllowMock(requestId) {
  return async (url, opts) => {
    if (opts?.method === 'POST') return new Response('', { status: 200 })
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ message: `allow:${requestId}` })}\n\n`))
        controller.close()
      }
    })
    return new Response(stream, { status: 200 })
  }
}

// A minimal "ntfy deny" mock
function ntfyDenyMock(requestId) {
  return async (url, opts) => {
    if (opts?.method === 'POST') return new Response('', { status: 200 })
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ message: `deny:${requestId}` })}\n\n`))
        controller.close()
      }
    })
    return new Response(stream, { status: 200 })
  }
}

const REQUEST = { tool: 'Bash', command: 'npm test', path: null, requestId: 'notify-req-001' }
const DEADLINE = () => Date.now() + 25_000

test('provider: null → "skip", fetch never called', async () => {
  let fetchCalled = false
  const restore = mockFetch(() => { fetchCalled = true })
  try {
    const config = { notifications: { provider: null, ntfyServer: 'https://ntfy.sh', ntfyTopic: null, timeout: 120 } }
    const result = await notify(config, REQUEST, DEADLINE())
    assert.strictEqual(result, 'skip')
    assert.strictEqual(fetchCalled, false)
  } finally { restore() }
})

test('provider: "ntfy" → delegates to ntfy, returns "allow"', async () => {
  const config = {
    notifications: { provider: 'ntfy', ntfyServer: 'https://ntfy.test', ntfyTopic: 'afk', timeout: 30 }
  }
  const restore = mockFetch(ntfyAllowMock(REQUEST.requestId))
  try {
    const result = await notify(config, REQUEST, DEADLINE())
    assert.strictEqual(result, 'allow')
  } finally { restore() }
})

test('provider: "telegram" → delegates to telegram, returns "deny"', async () => {
  // Build a minimal Telegram mock that returns deny callback
  const tgBase = 'https://api.telegram.org/botTOKEN'
  const config = {
    notifications: { provider: 'telegram', telegramToken: 'TOKEN', telegramChatId: '99', timeout: 30 }
  }
  let callCount = 0
  const restore = mockFetch(async (url) => {
    callCount++
    const json = (r) => new Response(JSON.stringify({ ok: true, result: r }), {
      status: 200, headers: { 'content-type': 'application/json' }
    })
    if (url.includes('getUpdates') && callCount === 1) return json([])
    if (url.includes('sendMessage'))                    return json({ message_id: 1 })
    if (url.includes('answerCallbackQuery'))            return json(true)
    return json([{ update_id: 1, callback_query: { id: 'cb1', data: `deny:${REQUEST.requestId}` } }])
  })
  try {
    const result = await notify(config, REQUEST, DEADLINE())
    assert.strictEqual(result, 'deny')
  } finally { restore() }
})

test('unknown provider → "skip"', async () => {
  let fetchCalled = false
  const restore = mockFetch(() => { fetchCalled = true })
  try {
    const config = { notifications: { provider: 'sms', timeout: 30 } }
    const result = await notify(config, REQUEST, DEADLINE())
    assert.strictEqual(result, 'skip')
    assert.strictEqual(fetchCalled, false)
  } finally { restore() }
})
