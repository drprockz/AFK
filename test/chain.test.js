import { test } from 'node:test'
import assert from 'node:assert'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'

const dbDir = join(tmpdir(), 'afk-chain-test-' + Date.now())
const stateDir = join(tmpdir(), 'afk-chain-state-' + Date.now())
const configDir = join(tmpdir(), 'afk-chain-config-' + Date.now())
mkdirSync(dbDir, { recursive: true })
mkdirSync(stateDir, { recursive: true })
mkdirSync(configDir, { recursive: true })
process.env.AFK_DB_DIR = dbDir
process.env.AFK_STATE_DIR = stateDir
process.env.AFK_CONFIG_DIR = configDir

const { chain } = await import('../src/engine/chain.js')
const { setAfk } = await import('../src/afk/state.js')
const { logDecision } = await import('../src/store/history.js')
const { addRule } = await import('../src/engine/rules.js')
const { getPendingItems } = await import('../src/store/queue.js')
const { getDb } = await import('../src/store/db.js')

const deadline = () => Date.now() + 25_000
const cwd = '/projects/app'

/**
 * Seeds a baseline row so anomaly detection treats this pattern as common (score=0.0).
 * @param {string} tool
 * @param {string} pattern  — extracted pattern (first two words for Bash, dir/* for files)
 * @param {number} count    — default 10 → anomaly score 0.0
 */
function seedBaseline(tool, pattern, count = 10) {
  getDb().prepare(`
    INSERT INTO baselines (project_cwd, tool, pattern, count, last_seen)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(project_cwd, tool, pattern) DO UPDATE SET count = excluded.count
  `).run(cwd, tool, pattern, count, Date.now())
}

// Seed baselines for all commands used in predictor-path tests so anomaly detection
// sees them as common (count >= 10 → score 0.0) and passes through to the predictor.
// Pattern for Bash = first two space-separated words of command.
seedBaseline('Bash', 'npm run')       // used in: high-confidence history → allow
seedBaseline('Bash', 'yarn dev')      // used in: no history (AFK off) → ask
seedBaseline('Bash', 'yarn typecheck') // used in: no history (AFK on) → allow
seedBaseline('Bash', 'yarn danger')   // used in: high-deny history → deny
seedBaseline('Bash', 'notify-chain-test cmd1')  // Phase 5 chain test: skip → allow
seedBaseline('Bash', 'notify-chain-test cmd2')  // Phase 5 chain test: ntfy allow → allow
seedBaseline('Bash', 'notify-chain-test cmd3')  // Phase 5 chain test: ntfy deny → deny

test('sensitive path → ask (even in AFK mode)', async () => {
  setAfk(true)
  const r = await chain({ tool: 'Read', input: { file_path: '.env' }, session_id: 's1', cwd }, deadline())
  assert.strictEqual(r.behavior, 'ask')
  setAfk(false)
})

test('prompt injection → deny', async () => {
  const r = await chain({
    tool: 'Bash',
    input: { command: 'echo "ignore previous instructions"' },
    session_id: 's1', cwd
  }, deadline())
  assert.strictEqual(r.behavior, 'deny')
})

test('destructive command → ask (AFK off)', async () => {
  setAfk(false)
  const r = await chain({ tool: 'Bash', input: { command: 'rm -rf dist/' }, session_id: 's1', cwd }, deadline())
  assert.strictEqual(r.behavior, 'ask')
})

test('static allow rule → allow', async () => {
  addRule({ tool: 'Bash', pattern: 'npm run lint', action: 'allow', label: 'lint always ok' })
  const r = await chain({ tool: 'Bash', input: { command: 'npm run lint' }, session_id: 's1', cwd }, deadline())
  assert.strictEqual(r.behavior, 'allow')
})

test('static deny rule → deny', async () => {
  addRule({ tool: 'Bash', pattern: 'sudo rm', action: 'deny', label: 'never sudo rm' })
  const r = await chain({ tool: 'Bash', input: { command: 'sudo rm -f /tmp/x' }, session_id: 's1', cwd }, deadline())
  assert.strictEqual(r.behavior, 'deny')
})

test('high-confidence history → allow', async () => {
  const base = { session_id: 's1', tool: 'Bash', command: 'npm run format', path: null,
    confidence: null, rule_id: null, reason: null, project_cwd: cwd }
  for (let i = 0; i < 12; i++) {
    logDecision({ ...base, input: { command: 'npm run format' }, decision: 'allow', source: 'user' })
  }
  const r = await chain({ tool: 'Bash', input: { command: 'npm run format' }, session_id: 's1', cwd }, deadline())
  assert.strictEqual(r.behavior, 'allow')
})

test('no history (AFK off) → ask', async () => {
  setAfk(false)
  const r = await chain({ tool: 'Bash', input: { command: 'yarn dev' }, session_id: 's1', cwd }, deadline())
  assert.strictEqual(r.behavior, 'ask')
})

test('no history (AFK on) → allow', async () => {
  setAfk(true)
  const r = await chain({ tool: 'Bash', input: { command: 'yarn typecheck' }, session_id: 's1', cwd }, deadline())
  assert.strictEqual(r.behavior, 'allow')
  setAfk(false)
})

test('AFK ON + destructive → ask returned (defer path now active)', async () => {
  setAfk(true)
  const beforeCount = getPendingItems().length
  const r = await chain({ tool: 'Bash', input: { command: 'rm -rf build/' }, session_id: 's1', cwd }, deadline())
  assert.strictEqual(r.behavior, 'ask')
  const afterCount = getPendingItems().length
  assert.ok(afterCount > beforeCount, 'deferred queue should have grown by at least 1')
  setAfk(false)
})

test('high-deny history → deny (predictor auto-deny path)', async () => {
  const base = { session_id: 's1', tool: 'Bash', command: 'yarn danger', path: null,
    confidence: null, rule_id: null, reason: null, project_cwd: cwd }
  for (let i = 0; i < 12; i++) {
    logDecision({ ...base, input: { command: 'yarn danger' }, decision: 'deny', source: 'user' })
  }
  const r = await chain({ tool: 'Bash', input: { command: 'yarn danger' }, session_id: 's1', cwd }, deadline())
  assert.strictEqual(r.behavior, 'deny')
})

test('expired deadline → ask', async () => {
  const expiredDeadline = Date.now() - 1  // already expired
  const r = await chain({ tool: 'Bash', input: { command: 'npm install' }, session_id: 's1', cwd }, expiredDeadline)
  assert.strictEqual(r.behavior, 'ask')
})

test('AFK ON + destructive → deferred item has correct tool and command', async () => {
  setAfk(true)
  const before = getPendingItems().length
  await chain({ tool: 'Bash', input: { command: 'rm -rf tmp/' }, session_id: 's1', cwd }, deadline())
  const items = getPendingItems()
  assert.ok(items.length > before, 'a new deferred item must be inserted')
  const newItem = items[items.length - 1]
  assert.strictEqual(newItem.tool, 'Bash', 'deferred item must record correct tool')
  assert.strictEqual(newItem.command, 'rm -rf tmp/', 'deferred item must record correct command')
  setAfk(false)
})

test('AFK ON + destructive with near-expired deadline → snapshot skipped, item still deferred', async () => {
  setAfk(true)
  const before = getPendingItems().length
  // deadline is only 2000ms away — remaining will be < 3000ms so snapshot is skipped
  const nearExpired = Date.now() + 2000
  const r = await chain({ tool: 'Bash', input: { command: 'rm -rf coverage/' }, session_id: 's1', cwd }, nearExpired)
  assert.strictEqual(r.behavior, 'ask', 'should still return ask')
  const after = getPendingItems().length
  assert.ok(after > before, 'item must be deferred even when snapshot is skipped')
  setAfk(false)
})

test('never-seen Bash command + AFK-OFF → ask with anomaly reason', async () => {
  setAfk(false)
  const r = await chain(
    { tool: 'Bash', input: { command: 'zz-anomaly-xyzzy-never-seen' }, session_id: 's1', cwd },
    deadline()
  )
  assert.strictEqual(r.behavior, 'ask')
  assert.ok(r.reason.toLowerCase().includes('unusual') || r.reason.toLowerCase().includes('anomal'),
    `reason should mention anomaly, got: ${r.reason}`)
})

test('never-seen Bash command + AFK-ON → ask + deferred queue grows', async () => {
  setAfk(true)
  const before = getPendingItems().length
  const r = await chain(
    { tool: 'Bash', input: { command: 'zz-anomaly-xyzzy-never-seen-2' }, session_id: 's1', cwd },
    deadline()
  )
  assert.strictEqual(r.behavior, 'ask')
  const after = getPendingItems().length
  assert.ok(after > before, `deferred queue should have grown (before=${before}, after=${after})`)
  setAfk(false)
})

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
