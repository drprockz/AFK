# Phase 5 — Notifications Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send push notifications (ntfy and Telegram) with Approve/Deny actions when AFK mode is ON and a request reaches the AFK fallback (Step 7), with fallback to auto-approve on timeout or missing config.

**Architecture:** Dispatcher pattern — `notify.js` reads config and routes to `ntfy.js` or `telegram.js`. Each provider is self-contained and never throws. `chain.js` Step 7 calls the dispatcher; any result other than `"deny"` auto-approves, preserving existing AFK behavior when notifications aren't configured.

**Tech Stack:** Node.js 18+ ESM, native `fetch` (global), `node:test` + `node:assert`, `better-sqlite3` (existing).

---

## File Map

| File | Change | Responsibility |
|------|--------|----------------|
| `src/notify/config.js` | **create** | Read `~/.claude/afk/config.json` with defaults; never throws |
| `src/notify/ntfy.js` | **create** | POST notification + SSE wait; returns `"allow" \| "deny" \| "timeout"` |
| `src/notify/telegram.js` | **create** | Send Telegram message + long-poll callback; returns `"allow" \| "deny" \| "timeout"` |
| `src/notify/notify.js` | **create** | Dispatcher: route to ntfy or telegram; returns `"allow" \| "deny" \| "timeout" \| "skip"` |
| `src/engine/chain.js` | **modify** | Replace Step 7 AFK auto-allow with notify → fallback |
| `test/config.test.js` | **create** | 3 tests for config loading |
| `test/ntfy.test.js` | **create** | 5 tests with mocked `fetch` |
| `test/telegram.test.js` | **create** | 5 tests with mocked `fetch` |
| `test/notify.test.js` | **create** | 4 tests for dispatcher routing |
| `test/chain.test.js` | **modify** | Add `AFK_CONFIG_DIR` isolation + 3 new tests |

---

## Chunk 1: Config + ntfy

### Task 1: Create `src/notify/config.js` + `test/config.test.js`

**Files:**
- Create: `src/notify/config.js`
- Create: `test/config.test.js`

- [ ] **Step 1.1: Write the failing tests** — create `test/config.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'

const testDir = join(tmpdir(), 'afk-config-test-' + Date.now())
mkdirSync(testDir, { recursive: true })
process.env.AFK_CONFIG_DIR = testDir

const { loadConfig } = await import('../src/notify/config.js')

test('missing config.json → returns defaults', () => {
  // testDir has no config.json yet
  const c = loadConfig()
  assert.strictEqual(c.notifications.provider, null)
  assert.strictEqual(c.notifications.ntfyServer, 'https://ntfy.sh')
  assert.strictEqual(c.notifications.timeout, 120)
})

test('valid config.json → merges notifications with defaults', () => {
  writeFileSync(join(testDir, 'config.json'), JSON.stringify({
    notifications: { provider: 'ntfy', ntfyTopic: 'my-topic' }
  }))
  const c = loadConfig()
  assert.strictEqual(c.notifications.provider, 'ntfy')
  assert.strictEqual(c.notifications.ntfyTopic, 'my-topic')
  assert.strictEqual(c.notifications.ntfyServer, 'https://ntfy.sh') // from defaults
  assert.strictEqual(c.notifications.timeout, 120)                   // from defaults
})

test('unparseable config.json → returns defaults, no throw', () => {
  writeFileSync(join(testDir, 'config.json'), 'not valid json {{')
  assert.doesNotThrow(() => {
    const c = loadConfig()
    assert.strictEqual(c.notifications.provider, null)
  })
})
```

- [ ] **Step 1.2: Run to verify they fail**

```bash
cd /home/darshanparmar/Projects/AFK && node --test test/config.test.js
```

Expected: `Error: Cannot find module '../src/notify/config.js'`

- [ ] **Step 1.3: Create `src/notify/config.js`**

```js
// src/notify/config.js
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DEFAULTS = {
  notifications: {
    provider: null,
    ntfyServer: 'https://ntfy.sh',
    ntfyTopic: null,
    telegramToken: null,
    telegramChatId: null,
    timeout: 120
  }
}

/**
 * Reads ~/.claude/afk/config.json and returns merged config with defaults.
 * Never throws — returns defaults if file is missing or unparseable.
 * AFK_CONFIG_DIR env var overrides the directory (used in tests).
 * @returns {object}
 */
export function loadConfig() {
  const dir = process.env.AFK_CONFIG_DIR ?? join(homedir(), '.claude', 'afk')
  const filePath = join(dir, 'config.json')
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf8'))
    return {
      ...DEFAULTS,
      ...raw,
      notifications: {
        ...DEFAULTS.notifications,
        ...(raw.notifications ?? {})
      }
    }
  } catch {
    return { ...DEFAULTS, notifications: { ...DEFAULTS.notifications } }
  }
}
```

- [ ] **Step 1.4: Run config tests to verify they pass**

```bash
cd /home/darshanparmar/Projects/AFK && node --test test/config.test.js
```

Expected: all 3 tests pass.

- [ ] **Step 1.5: Run full suite**

```bash
cd /home/darshanparmar/Projects/AFK && node --test test/*.test.js
```

Expected: all 110 tests pass (107 existing + 3 new).

- [ ] **Step 1.6: Commit**

```bash
cd /home/darshanparmar/Projects/AFK && git add src/notify/config.js test/config.test.js && git commit -m "feat: loadConfig — reads ~/.claude/afk/config.json with defaults (src/notify/config.js)"
```

---

### Task 2: Create `src/notify/ntfy.js` + `test/ntfy.test.js`

**Files:**
- Create: `src/notify/ntfy.js`
- Create: `test/ntfy.test.js`

**Background — how ntfy actions work:**
When the user taps Approve in the ntfy app, the ntfy client makes an outbound HTTP POST to the `responseTopic` URL with body `allow:<requestId>`. This publishes a new message to the response topic. The hook reads it via SSE (server-sent events) on that topic. The SSE stream returns JSON lines like:
```json
{"id":"...","event":"message","time":1234567890,"message":"allow:abc-123","topic":"..."}
```
The implementation reads `data:` lines, parses JSON, and checks `parsed.message?.startsWith('allow:<requestId>')`.

- [ ] **Step 2.1: Write the failing tests** — create `test/ntfy.test.js`:

```js
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
```

- [ ] **Step 2.2: Run to verify they fail**

```bash
cd /home/darshanparmar/Projects/AFK && node --test test/ntfy.test.js
```

Expected: `Error: Cannot find module '../src/notify/ntfy.js'`

- [ ] **Step 2.3: Create `src/notify/ntfy.js`**

```js
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
```

- [ ] **Step 2.4: Run ntfy tests to verify they pass**

```bash
cd /home/darshanparmar/Projects/AFK && node --test test/ntfy.test.js
```

Expected: all 5 tests pass.

- [ ] **Step 2.5: Run full suite**

```bash
cd /home/darshanparmar/Projects/AFK && node --test test/*.test.js
```

Expected: all 115 tests pass (110 existing + 5 new).

- [ ] **Step 2.6: Commit**

```bash
cd /home/darshanparmar/Projects/AFK && git add src/notify/ntfy.js test/ntfy.test.js && git commit -m "feat: ntfy notification provider — POST + SSE response (src/notify/ntfy.js)"
```

---

## Chunk 2: Telegram

### Task 3: Create `src/notify/telegram.js` + `test/telegram.test.js`

**Files:**
- Create: `src/notify/telegram.js`
- Create: `test/telegram.test.js`

**Background — Telegram flow:**
1. Fetch `getUpdates?limit=100` to capture the current highest `update_id`. All polling starts at `offset = highest + 1` to skip stale callbacks.
2. POST `sendMessage` with inline keyboard (Approve / Deny buttons). `callback_data` = `"allow:<requestId>"` or `"deny:<requestId>"`.
3. Long-poll `getUpdates?offset=<next>&timeout=<pollSeconds>` in a loop. When user taps a button, Telegram delivers a `callback_query` update with the matching `callback_data`.
4. On match: call `answerCallbackQuery` (best-effort, non-fatal), return `"allow"` or `"deny"`.
5. On elapsed ≥ waitMs: return `"timeout"`.

- [ ] **Step 3.1: Write the failing tests** — create `test/telegram.test.js`:

```js
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
```

- [ ] **Step 3.2: Run to verify they fail**

```bash
cd /home/darshanparmar/Projects/AFK && node --test test/telegram.test.js
```

Expected: `Error: Cannot find module '../src/notify/telegram.js'`

- [ ] **Step 3.3: Create `src/notify/telegram.js`**

```js
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
```

- [ ] **Step 3.4: Run telegram tests to verify they pass**

```bash
cd /home/darshanparmar/Projects/AFK && node --test test/telegram.test.js
```

Expected: all 5 tests pass.

- [ ] **Step 3.5: Run full suite**

```bash
cd /home/darshanparmar/Projects/AFK && node --test test/*.test.js
```

Expected: all 120 tests pass (115 existing + 5 new).

- [ ] **Step 3.6: Commit**

```bash
cd /home/darshanparmar/Projects/AFK && git add src/notify/telegram.js test/telegram.test.js && git commit -m "feat: Telegram notification provider — sendMessage + long-poll callback (src/notify/telegram.js)"
```

---

## Chunk 3: Dispatcher + Chain Wiring

### Task 4: Create `src/notify/notify.js` + `test/notify.test.js`

**Files:**
- Create: `src/notify/notify.js`
- Create: `test/notify.test.js`

- [ ] **Step 4.1: Write the failing tests** — create `test/notify.test.js`:

```js
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
```

- [ ] **Step 4.2: Run to verify they fail**

```bash
cd /home/darshanparmar/Projects/AFK && node --test test/notify.test.js
```

Expected: `Error: Cannot find module '../src/notify/notify.js'`

- [ ] **Step 4.3: Create `src/notify/notify.js`**

```js
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
```

- [ ] **Step 4.4: Run notify tests to verify they pass**

```bash
cd /home/darshanparmar/Projects/AFK && node --test test/notify.test.js
```

Expected: all 4 tests pass.

- [ ] **Step 4.5: Run full suite**

```bash
cd /home/darshanparmar/Projects/AFK && node --test test/*.test.js
```

Expected: all 124 tests pass (120 existing + 4 new).

- [ ] **Step 4.6: Commit**

```bash
cd /home/darshanparmar/Projects/AFK && git add src/notify/notify.js test/notify.test.js && git commit -m "feat: notification dispatcher — routes to ntfy or telegram (src/notify/notify.js)"
```

---

### Task 5: Wire notify into `src/engine/chain.js` + update `test/chain.test.js`

**Files:**
- Modify: `src/engine/chain.js`
- Modify: `test/chain.test.js`

**Key points:**
- `AFK_CONFIG_DIR` must be added to chain.test.js setup so tests use an isolated config dir (no real `~/.claude/afk/config.json` read). Without this, tests would fail on machines with a real ntfy/Telegram config.
- For chain tests 2 and 3 (notify returns allow/deny): the `requestId` is generated inside chain.js with `randomUUID()` — the test doesn't know it in advance. The fetch mock extracts it from the `Actions` header of the POST call (which contains `body=allow:<requestId>`).
- Seed baselines for test commands so anomaly detection passes through.

- [ ] **Step 5.1: Add 3 failing tests to `test/chain.test.js`**

First, add `AFK_CONFIG_DIR` isolation to the setup block at the top of the file (after the existing `AFK_STATE_DIR` lines):

```js
// Add after the mkdirSync lines in the setup block
const configDir = join(tmpdir(), 'afk-chain-config-' + Date.now())
mkdirSync(configDir, { recursive: true })
process.env.AFK_CONFIG_DIR = configDir
```

Also add these imports at the top:
```js
import { writeFileSync } from 'node:fs'
```

Then add seedBaseline calls for the new test commands near the other `seedBaseline` calls. **Note:** Bash anomaly patterns use the first two space-separated words of the command. Each test command has a distinct second word, so each must be seeded individually:
```js
seedBaseline('Bash', 'notify-chain-test cmd1')  // Phase 5 chain test: skip → allow
seedBaseline('Bash', 'notify-chain-test cmd2')  // Phase 5 chain test: ntfy allow → allow
seedBaseline('Bash', 'notify-chain-test cmd3')  // Phase 5 chain test: ntfy deny → deny
```

Then append the 3 new tests at the bottom of the file:

```js
test('AFK-ON + no provider (skip) → auto-allow', async () => {
  // configDir has no config.json → loadConfig returns provider:null → "skip" → allow
  setAfk(true)
  const r = await chain(
    { tool: 'Bash', input: { command: 'notify-chain-test cmd1' }, session_id: 's1', cwd },
    deadline()
  )
  assert.strictEqual(r.behavior, 'allow')
  setAfk(false)
})

test('AFK-ON + ntfy returns allow → allow', async () => {
  setAfk(true)
  // Write ntfy config to the isolated configDir
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({
    notifications: { provider: 'ntfy', ntfyServer: 'https://ntfy.test', ntfyTopic: 'afk', timeout: 10 }
  }))

  // Mock fetch: capture requestId from POST Actions header, emit allow event in SSE
  const orig = globalThis.fetch
  let capturedId = null
  globalThis.fetch = async (url, opts) => {
    if (opts?.method === 'POST' && !url.includes('api.telegram.org')) {
      // Extract requestId from Actions header: "..., body=allow:<id>;..."
      const actions = opts.headers?.Actions ?? ''
      const m = actions.match(/body=allow:([^\s;]+)/)
      capturedId = m?.[1] ?? ''
      return new Response('', { status: 200 })
    }
    // SSE: emit the allow event using the captured requestId
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      start(controller) {
        if (capturedId) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ message: `allow:${capturedId}` })}\n\n`))
        }
        controller.close()
      }
    })
    return new Response(stream, { status: 200 })
  }

  try {
    const r = await chain(
      { tool: 'Bash', input: { command: 'notify-chain-test cmd2' }, session_id: 's1', cwd },
      deadline()
    )
    assert.strictEqual(r.behavior, 'allow')
  } finally {
    globalThis.fetch = orig
    setAfk(false)
    // Remove config so other tests use provider:null
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({ notifications: { provider: null } }))
  }
})

test('AFK-ON + ntfy returns deny → deny', async () => {
  setAfk(true)
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({
    notifications: { provider: 'ntfy', ntfyServer: 'https://ntfy.test', ntfyTopic: 'afk', timeout: 10 }
  }))

  const orig = globalThis.fetch
  let capturedId = null
  globalThis.fetch = async (url, opts) => {
    if (opts?.method === 'POST' && !url.includes('api.telegram.org')) {
      const actions = opts.headers?.Actions ?? ''
      const m = actions.match(/body=allow:([^\s;]+)/)
      capturedId = m?.[1] ?? ''
      return new Response('', { status: 200 })
    }
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      start(controller) {
        if (capturedId) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ message: `deny:${capturedId}` })}\n\n`))
        }
        controller.close()
      }
    })
    return new Response(stream, { status: 200 })
  }

  try {
    const r = await chain(
      { tool: 'Bash', input: { command: 'notify-chain-test cmd3' }, session_id: 's1', cwd },
      deadline()
    )
    assert.strictEqual(r.behavior, 'deny')
  } finally {
    globalThis.fetch = orig
    setAfk(false)
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({ notifications: { provider: null } }))
  }
})
```

- [ ] **Step 5.2: Run chain tests to verify the 3 new tests fail**

```bash
cd /home/darshanparmar/Projects/AFK && node --test test/chain.test.js
```

Expected: existing 15 tests pass, 3 new tests fail (chain.js still has old Step 7).

- [ ] **Step 5.3: Modify `src/engine/chain.js`**

**Add imports** — after the existing import block (after line 13), add:

```js
import { notify } from '../notify/notify.js'
import { loadConfig } from '../notify/config.js'
import { randomUUID } from 'node:crypto'
```

**Replace Step 7 AFK auto-allow** — find this exact block in chain.js:

```js
  if (afkOn) {
    log('allow', 'auto_afk', { reason: 'AFK mode: auto-approved' })
    appendDigest({ tool, command, path, decision: 'allow', ts: Date.now() })
    return { behavior: 'allow', reason: 'AFK mode: auto-approved' }
  }
```

Replace with:

```js
  if (afkOn) {
    const requestId = randomUUID()
    const notifyResult = await notify(loadConfig(), { tool, command, path, requestId }, deadline)
    if (notifyResult === 'deny') {
      log('deny', 'notification', { reason: 'User denied via notification' })
      appendDigest({ tool, command, path, decision: 'deny', ts: Date.now() })
      return { behavior: 'deny', reason: 'Denied via push notification' }
    }
    // "allow", "skip", or "timeout" → fall through to auto-approve
    log('allow', 'auto_afk', { reason: `AFK mode: auto-approved (notify=${notifyResult})` })
    appendDigest({ tool, command, path, decision: 'allow', ts: Date.now() })
    return { behavior: 'allow', reason: 'AFK mode: auto-approved' }
  }
```

- [ ] **Step 5.4: Run chain tests to verify all pass**

```bash
cd /home/darshanparmar/Projects/AFK && node --test test/chain.test.js
```

Expected: all 18 tests pass (15 existing + 3 new).

- [ ] **Step 5.5: Run full suite**

```bash
cd /home/darshanparmar/Projects/AFK && node --test test/*.test.js
```

Expected: all 127 tests pass (124 existing + 3 new).

- [ ] **Step 5.6: Commit**

```bash
cd /home/darshanparmar/Projects/AFK && git add src/engine/chain.js test/chain.test.js && git commit -m "feat: wire notify dispatcher into chain Step 7 (AFK-ON: notify → fallback auto-approve)"
```

---

## Verification

After all tasks are done:

```bash
cd /home/darshanparmar/Projects/AFK && node --test test/*.test.js 2>&1 | tail -6
```

Expected:
```
# tests 127
# pass  127
# fail  0
```

```bash
git log --oneline -5
```

Expected to see 5 new commits from this phase:
```
<sha>  feat: wire notify dispatcher into chain Step 7 (AFK-ON: notify → fallback auto-approve)
<sha>  feat: notification dispatcher — routes to ntfy or telegram (src/notify/notify.js)
<sha>  feat: Telegram notification provider — sendMessage + long-poll callback (src/notify/telegram.js)
<sha>  feat: ntfy notification provider — POST + SSE response (src/notify/ntfy.js)
<sha>  feat: loadConfig — reads ~/.claude/afk/config.json with defaults (src/notify/config.js)
```
