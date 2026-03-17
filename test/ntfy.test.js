import { test } from 'node:test'
import assert from 'node:assert'
import { notify } from '../src/notify/ntfy.js'

const CONFIG = { ntfyServer: 'https://ntfy.test', ntfyTopic: 'afk-test' }
const REQ    = { tool: 'Bash', command: 'npm test', path: null, requestId: 'test-req-id-001' }

// Helper: replace globalThis.fetch with a mock, return restore function
function mockFetch(fn) {
  const orig = globalThis.fetch
  globalThis.fetch = fn
  return () => { globalThis.fetch = orig }
}

// Helper: build a ReadableStream SSE response that emits one event
function sseResponse(message) {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ message })}\n\n`))
      controller.close()
    }
  })
  return new Response(stream, { status: 200 })
}

// Helper: build a hanging SSE response that respects the AbortSignal
function hangingSseResponse(signal) {
  const stream = new ReadableStream({
    start(controller) {
      signal?.addEventListener('abort', () => controller.error(new Error('aborted')))
    }
  })
  return new Response(stream, { status: 200 })
}

test('approve response → "allow"', async () => {
  const restore = mockFetch(async (url, opts) => {
    if (opts?.method === 'POST') return new Response('', { status: 200 })
    return sseResponse(`allow:${REQ.requestId}`)
  })
  try {
    const result = await notify(CONFIG, REQ, 5000)
    assert.strictEqual(result, 'allow')
  } finally { restore() }
})

test('deny response → "deny"', async () => {
  const restore = mockFetch(async (url, opts) => {
    if (opts?.method === 'POST') return new Response('', { status: 200 })
    return sseResponse(`deny:${REQ.requestId}`)
  })
  try {
    const result = await notify(CONFIG, REQ, 5000)
    assert.strictEqual(result, 'deny')
  } finally { restore() }
})

test('SSE never delivers → "timeout"', async () => {
  const restore = mockFetch(async (url, opts) => {
    if (opts?.method === 'POST') return new Response('', { status: 200 })
    return hangingSseResponse(opts?.signal)
  })
  try {
    const start = Date.now()
    const result = await notify(CONFIG, REQ, 150)
    assert.strictEqual(result, 'timeout')
    assert.ok(Date.now() - start < 500, 'should return within ~150ms, not hang')
  } finally { restore() }
})

test('POST fetch throws → "timeout", no throw', async () => {
  const restore = mockFetch(async () => { throw new Error('network error') })
  try {
    // Unhandled rejection would fail the test — no explicit doesNotThrow needed for async
    const result = await notify(CONFIG, REQ, 5000)
    assert.strictEqual(result, 'timeout')
  } finally { restore() }
})

test('SSE fetch throws → "timeout", no throw', async () => {
  const restore = mockFetch(async (url, opts) => {
    if (opts?.method === 'POST') return new Response('', { status: 200 })
    throw new Error('sse connection failed')
  })
  try {
    const result = await notify(CONFIG, REQ, 5000)
    assert.strictEqual(result, 'timeout')
  } finally { restore() }
})
