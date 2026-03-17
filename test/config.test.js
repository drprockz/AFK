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
