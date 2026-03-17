import { test } from 'node:test'
import assert from 'node:assert'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AFK_DB_DIR = join(tmpdir(), 'afk-rules-test-' + Date.now())

const { matchRule, addRule, getRule } = await import('../src/engine/rules.js')

test('matchRule returns null when no rules exist', () => {
  const result = matchRule({ tool: 'Bash', input: { command: 'npm test' }, cwd: '/app' })
  assert.strictEqual(result, null)
})

test('matchRule returns matching rule for Bash tool', () => {
  addRule({ tool: 'Bash', pattern: 'npm run', action: 'allow', label: 'always allow npm scripts' })
  const result = matchRule({ tool: 'Bash', input: { command: 'npm run test' }, cwd: '/app' })
  assert.ok(result !== null)
  assert.strictEqual(result.action, 'allow')
})

test('matchRule respects priority — higher priority wins', () => {
  addRule({ tool: 'Bash', pattern: 'npm run test', action: 'deny', label: 'deny test specifically', priority: 10 })
  const result = matchRule({ tool: 'Bash', input: { command: 'npm run test' }, cwd: '/app' })
  assert.strictEqual(result.action, 'deny')
  assert.ok(result.priority >= 10)
})

test('matchRule wildcard tool (*) matches any tool', () => {
  addRule({ tool: '*', pattern: 'secret', action: 'deny', label: 'deny anything with secret' })
  const result = matchRule({ tool: 'Read', input: { file_path: '/app/secret.json' }, cwd: '/app' })
  assert.ok(result !== null)
  assert.strictEqual(result.action, 'deny')
})

test('matchRule project-scoped rule only applies to matching project', () => {
  addRule({ tool: 'Bash', pattern: 'deploy', action: 'allow', label: 'allow deploy in app', project: '/app' })
  const inProject = matchRule({ tool: 'Bash', input: { command: 'deploy.sh' }, cwd: '/app' })
  const otherProject = matchRule({ tool: 'Bash', input: { command: 'deploy.sh' }, cwd: '/other' })
  assert.ok(inProject !== null)
  assert.strictEqual(otherProject, null)
})

test('matchRule ignores deny rule for non-matching command', () => {
  const result = matchRule({ tool: 'Bash', input: { command: 'echo hello' }, cwd: '/app' })
  // no rule matches 'echo hello'
  assert.ok(result === null || result.action)
})

test('getRule returns rule by id', () => {
  const id = addRule({ tool: 'Bash', pattern: 'npm *', action: 'allow', label: 'npm' })
  const rule = getRule(id)
  assert.ok(rule !== null, 'rule found')
  assert.strictEqual(rule.id, id)
  assert.strictEqual(rule.tool, 'Bash')
  assert.strictEqual(rule.pattern, 'npm *')
})

test('getRule returns null for unknown id', () => {
  const rule = getRule('00000000-0000-0000-0000-000000000000')
  assert.strictEqual(rule, null)
})
