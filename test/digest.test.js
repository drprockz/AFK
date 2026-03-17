import { test } from 'node:test'
import assert from 'node:assert'

// digest.js is a pure function — no env vars or DB needed
const { buildDigest } = await import('../src/afk/digest.js')

test('groups allow entries by tool with counts', () => {
  const entries = [
    { tool: 'Bash', command: 'npm run build', path: null, decision: 'allow', ts: 1 },
    { tool: 'Bash', command: 'npm test', path: null, decision: 'allow', ts: 2 },
    { tool: 'Read', command: null, path: 'src/app.js', decision: 'allow', ts: 3 },
  ]
  const result = buildDigest(entries, 0)
  assert.ok(result.includes('Auto-approved (3)'), 'should show total auto-approved count')
  assert.ok(result.includes('Bash ×2'), 'should group Bash entries')
  assert.ok(result.includes('Read ×1'), 'should group Read entries')
})

test('lists defer entries individually with sequential index', () => {
  const entries = [
    { tool: 'Bash', command: 'rm -rf dist/', path: null, decision: 'defer', ts: 1 },
    { tool: 'Bash', command: 'DROP TABLE logs', path: null, decision: 'defer', ts: 2 },
  ]
  const result = buildDigest(entries, 2)
  assert.ok(result.includes('[1] Bash: rm -rf dist/'), 'first deferred item')
  assert.ok(result.includes('[2] Bash: DROP TABLE logs'), 'second deferred item')
})

test('returns "No activity during AFK session." when entries empty and pendingCount=0', () => {
  const result = buildDigest([], 0)
  assert.strictEqual(result, 'No activity during AFK session.')
})

test('silently ignores entries with unknown decision values', () => {
  const entries = [
    { tool: 'Bash', command: 'npm test', path: null, decision: 'allow', ts: 1 },
    { tool: 'Bash', command: 'something', path: null, decision: 'ask', ts: 2 },  // unknown
    { tool: 'Bash', command: 'other', path: null, decision: 'deny', ts: 3 },    // unknown
  ]
  const result = buildDigest(entries, 0)
  assert.ok(result.includes('Auto-approved (1)'), 'only 1 allow entry counted')
  assert.ok(!result.includes('ask'), 'ask entries not shown')
  assert.ok(!result.includes('deny'), 'deny entries not shown')
})

test('shows deferred section when entries empty but pendingCount > 0', () => {
  // Covers spec: "entries is empty but pendingCount > 0 → show only the deferred section"
  const result = buildDigest([], 3)
  assert.ok(result !== 'No activity during AFK session.', 'should not return no-activity message')
  assert.ok(result.includes('Deferred for your review (3)'), 'should show deferred count')
})
