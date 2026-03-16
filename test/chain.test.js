import { test } from 'node:test'
import assert from 'node:assert'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

const dbDir = join(tmpdir(), 'afk-chain-test-' + Date.now())
const stateDir = join(tmpdir(), 'afk-chain-state-' + Date.now())
mkdirSync(dbDir, { recursive: true })
mkdirSync(stateDir, { recursive: true })
process.env.AFK_DB_DIR = dbDir
process.env.AFK_STATE_DIR = stateDir

const { chain } = await import('../src/engine/chain.js')
const { setAfk } = await import('../src/afk/state.js')
const { logDecision } = await import('../src/store/history.js')
const { addRule } = await import('../src/engine/rules.js')

const deadline = () => Date.now() + 25_000
const cwd = '/projects/app'

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

test('destructive command → ask (AFK on — Phase 3 not yet wired)', async () => {
  setAfk(true)
  const r = await chain({ tool: 'Bash', input: { command: 'rm -rf build/' }, session_id: 's1', cwd }, deadline())
  assert.strictEqual(r.behavior, 'ask')  // ask regardless of AFK until Phase 3 wires snapshot+queue
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
