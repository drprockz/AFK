# Phase 5 — Notifications Design

**Date:** 2026-03-17
**Phase:** 5 of 7
**Goal:** Send push notifications with Approve/Deny actions when AFK mode is ON and a request lands in the predictor uncertainty band. Wire into chain Step 7 using a provider-agnostic dispatcher.

---

## Context

After Phases 1–4, the chain's Step 7 (AFK fallback) auto-approves any request that reaches it in AFK mode. Phase 5 intercepts that auto-approve: if a notification provider is configured, it sends a push notification and waits for the user's response before deciding. If the user doesn't respond (timeout) or no provider is configured, it falls back to the existing auto-approve behavior.

No other chain steps are changed. Sensitive path, anomaly, and destructive classifier paths keep their current behavior.

---

## Scope

Phase 5 builds:
1. `src/notify/ntfy.js` — ntfy provider
2. `src/notify/telegram.js` — Telegram provider
3. `src/notify/notify.js` — dispatcher (routes to ntfy or telegram based on config)
4. `src/notify/config.js` — config file reader with defaults
5. Modify `src/engine/chain.js` — replace Step 7 AFK auto-allow with notify → fallback pattern

Notifications only fire in the AFK fallback (Step 7). Scope does not include:
- Notifying on sensitive path detections
- Notifying on anomaly detections
- Dashboard queue integration (Phase 6)

---

## File Map

| File | Change | Responsibility |
|------|--------|----------------|
| `src/notify/config.js` | **create** | Read `~/.claude/afk/config.json`, return merged config with defaults; never throws |
| `src/notify/ntfy.js` | **create** | POST to ntfy; SSE-listen for approve/deny; return `"allow" \| "deny" \| "timeout"` |
| `src/notify/telegram.js` | **create** | Send Telegram message with inline keyboard; long-poll for callback; return `"allow" \| "deny" \| "timeout"` |
| `src/notify/notify.js` | **create** | Dispatcher: read provider from config, route to ntfy or telegram, return `"allow" \| "deny" \| "timeout" \| "skip"` |
| `src/engine/chain.js` | **modify** | Replace Step 7 AFK auto-allow with notify dispatcher call + fallback |
| `test/ntfy.test.js` | **create** | 5 unit tests with mocked `fetch` |
| `test/telegram.test.js` | **create** | 5 unit tests with mocked `fetch` |
| `test/notify.test.js` | **create** | 4 unit tests for dispatcher routing |
| `test/chain.test.js` | **modify** | 3 new tests for AFK+notify path |

---

## `src/notify/config.js`

Reads `~/.claude/afk/config.json` synchronously. Returns a full config object with safe defaults. Never throws.

```js
export function loadConfig()
```

- Config file path: `${AFK_CONFIG_DIR ?? join(homedir(), '.claude', 'afk')}/config.json`
  - `AFK_CONFIG_DIR` env var allows tests to override the path
- If file missing or unparseable → return defaults silently
- Defaults:
  ```js
  {
    notifications: {
      provider: null,
      ntfyServer: 'https://ntfy.sh',
      ntfyTopic: null,
      telegramToken: null,
      telegramChatId: null,
      timeout: 120
    }
  }
  ```
- Merges file content shallowly: `{ ...defaults, ...fileContent, notifications: { ...defaults.notifications, ...fileContent.notifications } }`

---

## `src/notify/ntfy.js`

### Function signature

```js
export async function notify(notifyConfig, { tool, command, path, requestId }, waitMs)
// notifyConfig: the notifications sub-object from config (ntfyServer, ntfyTopic, timeout)
// waitMs: milliseconds to wait for a response before returning "timeout"
// returns: "allow" | "deny" | "timeout"
```

Never throws — entire body is wrapped in try/catch returning `"timeout"` on any error.

### Send notification

POST to `${notifyConfig.ntfyServer}/${notifyConfig.ntfyTopic}`:

```
Headers:
  Title: AFK – ${tool} request
  Priority: high
  Tags: robot
  Actions: http, Approve, ${responseTopic}, method=POST, body=allow:${requestId}; http, Deny, ${responseTopic}, method=POST, body=deny:${requestId}
Body: ${command ?? path ?? tool}
```

`responseTopic` = `${notifyConfig.ntfyServer}/${notifyConfig.ntfyTopic}-response`

When the user taps Approve or Deny in the ntfy app, the ntfy client makes an outbound HTTP POST to `responseTopic` with body `allow:<requestId>` or `deny:<requestId>`. This publishes a new message to the response topic, which the hook reads via SSE below.

### Wait for SSE response

Subscribe to `${notifyConfig.ntfyServer}/${notifyConfig.ntfyTopic}-response/sse?since=<ts_before_send>`:

- `ts_before_send` = Unix seconds timestamp (in seconds, not ms) captured immediately before the POST
- Parse each SSE `data` line as JSON; check `parsed.message` starts with `allow:<requestId>` or `deny:<requestId>`
- Extract the decision from the `message` prefix → `"allow"` or `"deny"`
- Race against a `setTimeout(waitMs)` — on timeout, abort the SSE fetch and return `"timeout"`
- On any fetch error → return `"timeout"`

---

## `src/notify/telegram.js`

### Function signature

```js
export async function notify(notifyConfig, { tool, command, path, requestId }, waitMs)
// notifyConfig: notifications sub-object (telegramToken, telegramChatId, timeout)
// waitMs: milliseconds to wait before returning "timeout"
// returns: "allow" | "deny" | "timeout"
```

Never throws — entire body is wrapped in try/catch returning `"timeout"` on any error.

### Send message

POST to `https://api.telegram.org/bot${notifyConfig.telegramToken}/sendMessage`:

```json
{
  "chat_id": "<telegramChatId>",
  "text": "AFK – <tool> request\n<command ?? path ?? tool>",
  "reply_markup": {
    "inline_keyboard": [[
      { "text": "✅ Approve", "callback_data": "allow:<requestId>" },
      { "text": "❌ Deny",    "callback_data": "deny:<requestId>" }
    ]]
  }
}
```

### Get baseline update offset

Before sending the message, fetch `getUpdates?limit=100` (no offset filter) to get all pending updates. Take the highest `update_id` seen, or 0 if none. All subsequent polling starts at `offset = highest_update_id + 1` to ignore stale callbacks.

Note: the common `offset=-1` trick is undocumented in the official Telegram Bot API and should not be used. Fetching pending updates and taking the max is the safe approach.

### Poll for callback

Loop: GET `getUpdates?offset=<next_offset>&timeout=<pollSeconds>&allowed_updates=["callback_query"]`

- `pollSeconds` = `Math.max(1, Math.min(30, Math.floor(remainingMs / 1000) - 1))` — long-polling, capped at 30s per request, minimum 1s to avoid API errors
- On each response: check `result` array for a `callback_query` where `callback_data` starts with `allow:<requestId>` or `deny:<requestId>`
- On match:
  - Call `answerCallbackQuery` (best-effort, fire-and-forget, non-fatal)
  - Return `"allow"` or `"deny"`
- On no match: advance `next_offset`, repeat if time remains
- On total elapsed ≥ `waitMs`: return `"timeout"`
- On any fetch error: return `"timeout"`

---

## `src/notify/notify.js`

### Function signature

```js
export async function notify(config, { tool, command, path, requestId }, deadline)
// config: full config object (from loadConfig())
// deadline: chain deadline Unix ms timestamp
// returns: "allow" | "deny" | "timeout" | "skip"
```

Never throws — outer try/catch returns `"skip"` on any error.

### Logic

```
provider = config.notifications?.provider

if provider is null/undefined/falsy → return "skip"

waitMs = Math.min(
  (config.notifications.timeout ?? 120) * 1000,
  deadline - Date.now() - 2000   // always leave 2s buffer for chain teardown
)
if waitMs <= 0 → return "timeout"

if provider === "ntfy"     → return ntfy.notify(config.notifications, { tool, command, path, requestId }, waitMs)
if provider === "telegram" → return telegram.notify(config.notifications, { tool, command, path, requestId }, waitMs)
else → return "skip"   (unknown provider)
```

---

## `src/engine/chain.js` — Step 7 modification

### Add imports

```js
import { notify } from '../notify/notify.js'
import { loadConfig } from '../notify/config.js'
import { randomUUID } from 'node:crypto'
```

Note: `deadline` is already in scope — it is a parameter of `export async function chain(request, deadline)` and is used throughout the existing chain for the destructive classifier snapshot timeout check.

### Replace Step 7 AFK auto-allow

Current:
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
  // allow, skip, or timeout → fall through to auto-approve
  log('allow', 'auto_afk', { reason: `AFK mode: auto-approved (notify=${notifyResult})` })
  appendDigest({ tool, command, path, decision: 'allow', ts: Date.now() })
  return { behavior: 'allow', reason: 'AFK mode: auto-approved' }
}
```

`"allow"`, `"skip"`, and `"timeout"` all produce the same result: auto-approve. This preserves existing AFK behavior when notifications aren't configured or the user doesn't respond.

---

## Decision flow after Phase 5

```
Step 1  Sensitive path guard    → always ask (no change)
Step 2  Prompt injection        → deny (no change)
Step 3  Destructive classifier  → defer/ask (no change)
Step 4  Static rules            → allow/deny (no change)
Step 5  Anomaly detector        → defer (AFK-ON) or ask (AFK-OFF) (no change)
Step 6  Behaviour predictor     → allow/deny if confidence ≥ 0.85 or ≤ 0.15 (no change)
Step 7  AFK fallback            → NEW: notify (ntfy/Telegram) → allow on approve/skip/timeout, deny on deny
                                  (AFK-OFF path unchanged: return ask)
```

---

## Testing

### `test/ntfy.test.js` — 5 tests

All tests mock `globalThis.fetch` at the top of the file. Each test restores the original fetch after.

| # | Test | Setup | Expected |
|---|------|-------|----------|
| 1 | approve response | POST mock succeeds; SSE mock returns JSON event with `message` field = `"allow:<requestId>"` | returns `"allow"` |
| 2 | deny response | SSE mock returns JSON event with `message` field = `"deny:<requestId>"` | returns `"deny"` |
| 3 | SSE timeout | SSE mock hangs (never resolves) | returns `"timeout"` within `waitMs` |
| 4 | POST throws | fetch mock throws on first call | returns `"timeout"`, no throw |
| 5 | SSE fetch throws | POST succeeds; SSE fetch throws | returns `"timeout"`, no throw |

### `test/telegram.test.js` — 5 tests

All tests mock `globalThis.fetch`.

| # | Test | Setup | Expected |
|---|------|-------|----------|
| 1 | approve callback | `getUpdates` (baseline) mock returns empty; `sendMessage` succeeds; `getUpdates` (poll) returns `callback_query` with `allow:<requestId>` | returns `"allow"` |
| 2 | deny callback | poll returns `deny:<requestId>` | returns `"deny"` |
| 3 | poll timeout | poll always returns empty result; waitMs expires | returns `"timeout"` |
| 4 | sendMessage throws | fetch throws on sendMessage call | returns `"timeout"`, no throw |
| 5 | getUpdates (poll) throws | sendMessage succeeds; poll fetch throws | returns `"timeout"`, no throw |

### `test/notify.test.js` — 4 tests

| # | Test | Setup | Expected |
|---|------|-------|----------|
| 1 | provider null | config with `provider: null` | returns `"skip"`, fetch never called |
| 2 | provider ntfy | config with `provider: "ntfy"`; mock ntfy returns `"allow"` | returns `"allow"` |
| 3 | provider telegram | config with `provider: "telegram"`; mock telegram returns `"deny"` | returns `"deny"` |
| 4 | unknown provider | config with `provider: "sms"` | returns `"skip"` |

### `test/chain.test.js` — 3 new tests

These tests seed baselines (count=10) for the commands used, to bypass anomaly detection. They mock `notify` by setting `AFK_CONFIG_DIR` to a temp dir with a config file that has `provider: null` (for the skip test) or by passing config with a known-null provider.

| # | Test | Setup | Expected |
|---|------|-------|----------|
| 1 | AFK-ON + no provider configured | config dir has no config.json → provider=null | behavior=allow (skip path) |
| 2 | AFK-ON + notify returns allow | config with provider=ntfy; mock ntfy returns allow | behavior=allow |
| 3 | AFK-ON + notify returns deny | config with provider=ntfy; mock ntfy returns deny | behavior=deny |

**Note on chain test mocking:** Since chain.js imports `notify` from `'../notify/notify.js'` statically, tests control the notification outcome by providing a real config with `provider: null` (exercises skip path). Testing the allow/deny response paths requires either a test-double config dir pointing to a mock ntfy or using the actual notify module with a mock fetch — use the mock-fetch approach for tests 2 and 3.

---

## Error Handling Summary

| Scenario | Behaviour |
|----------|-----------|
| `notify` throws (any reason) | try/catch returns `"skip"` → chain auto-approves |
| ntfy POST fails | returns `"timeout"` → chain auto-approves |
| ntfy SSE never delivers | waitMs expires → returns `"timeout"` → chain auto-approves |
| Telegram sendMessage fails | returns `"timeout"` → chain auto-approves |
| Telegram poll never matches | waitMs expires → returns `"timeout"` → chain auto-approves |
| config.json missing | loadConfig() returns defaults → provider=null → skip |
| deadline too close (waitMs ≤ 0) | returns `"timeout"` immediately → chain auto-approves |

All failure modes degrade to auto-approve — same as pre-Phase-5 AFK behavior. Notifications are additive, never blocking.

---

## Out of Scope for Phase 5

- Notifying on sensitive path or anomaly detections in AFK mode
- Dashboard queue as a fallback on notification timeout (Phase 6)
- `onlyFor` severity filter from config (Phase 7 polish)
- `/afk:notify` command to test the notification setup
- Multiple providers simultaneously
