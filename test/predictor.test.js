import { test } from 'node:test'
import assert from 'node:assert'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AFK_DB_DIR = join(tmpdir(), 'afk-predictor-test-' + Date.now())

const { predict } = await import('../src/engine/predictor.js')
const { logDecision } = await import('../src/store/history.js')

const base = {
  session_id: 'test',
  tool: 'Bash',
  input: { command: 'npm run test' },
  command: 'npm run test',
  path: null,
  decision: 'allow',
  source: 'user',
  confidence: null,
  rule_id: null,
  reason: null,
  project_cwd: '/projects/app'
}

test('predict returns confidence=0.5 with no history (< 3 samples)', () => {
  const r = predict({ tool: 'Bash', input: { command: 'npm run build' }, cwd: '/projects/app' })
  assert.strictEqual(r.confidence, 0.5)
  assert.ok(r.sample_size < 3)
})

test('predict returns high confidence after many approvals', () => {
  for (let i = 0; i < 10; i++) {
    logDecision({ ...base, input: { command: 'npm run build' }, command: 'npm run build', decision: 'allow' })
  }
  const r = predict({ tool: 'Bash', input: { command: 'npm run build' }, cwd: '/projects/app' })
  assert.ok(r.confidence > 0.85, `expected confidence > 0.85, got ${r.confidence}`)
  assert.strictEqual(r.predicted, 'allow')
})

test('predict returns low confidence after many denials', () => {
  for (let i = 0; i < 10; i++) {
    logDecision({ ...base, input: { command: 'yarn deploy' }, command: 'yarn deploy', decision: 'deny' })
  }
  const r = predict({ tool: 'Bash', input: { command: 'yarn deploy' }, cwd: '/projects/app' })
  assert.ok(r.confidence < 0.15, `expected confidence < 0.15, got ${r.confidence}`)
  assert.strictEqual(r.predicted, 'deny')
})

test('predict explanation is human-readable', () => {
  const r = predict({ tool: 'Bash', input: { command: 'npm run test' }, cwd: '/projects/app' })
  assert.ok(typeof r.explanation === 'string' && r.explanation.length > 0)
})

test('predict ignores decisions from other projects', () => {
  for (let i = 0; i < 10; i++) {
    logDecision({ ...base, input: { command: 'yarn build' }, decision: 'allow', project_cwd: '/other' })
  }
  const r = predict({ tool: 'Bash', input: { command: 'yarn build' }, cwd: '/projects/app' })
  assert.strictEqual(r.confidence, 0.5, 'cross-project decisions should be ignored')
})
