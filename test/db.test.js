import { test } from 'node:test'
import assert from 'node:assert'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Use a temp path so tests don't touch ~/.claude/afk/
const testDbDir = join(tmpdir(), 'afk-test-' + Date.now())
process.env.AFK_DB_DIR = testDbDir

const { getDb } = await import('../src/store/db.js')

test('db initializes and all tables exist', () => {
  const db = getDb()
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
  ).all().map(r => r.name)

  assert.ok(tables.includes('decisions'), 'decisions table missing')
  assert.ok(tables.includes('deferred'), 'deferred table missing')
  assert.ok(tables.includes('rules'), 'rules table missing')
  assert.ok(tables.includes('sessions'), 'sessions table missing')
  assert.ok(tables.includes('baselines'), 'baselines table missing')
})

test('db uses WAL mode', () => {
  const db = getDb()
  const mode = db.pragma('journal_mode', { simple: true })
  assert.strictEqual(mode, 'wal')
})

test('getDb returns the same instance on repeated calls', () => {
  const db1 = getDb()
  const db2 = getDb()
  assert.strictEqual(db1, db2)
})
