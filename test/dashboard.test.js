import { test, before, after } from 'node:test'
import assert from 'node:assert'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, rmSync } from 'node:fs'

// Isolate all AFK data stores before any module imports
const testDir = join(tmpdir(), 'afk-dashboard-test-' + Date.now())
mkdirSync(testDir, { recursive: true })
process.env.AFK_DB_DIR     = testDir
process.env.AFK_STATE_DIR  = testDir
process.env.AFK_CONFIG_DIR = testDir

const { startServer, stopServer } = await import('../src/dashboard/server.js')

// ── helpers ──────────────────────────────────────────────────────────────────
const BASE = 'http://127.0.0.1:16789'
async function get(path) {
  const res = await fetch(`${BASE}${path}`)
  return { status: res.status, body: await res.json() }
}
async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  return { status: res.status, body: await res.json() }
}
async function del(path) {
  const res = await fetch(`${BASE}${path}`, { method: 'DELETE' })
  return { status: res.status, body: await res.json() }
}

before(async () => {
  startServer(16789)
  // wait briefly for server to bind
  await new Promise(r => setTimeout(r, 100))
})

after(async () => {
  await stopServer()
  rmSync(testDir, { recursive: true, force: true })
})

test('GET /api/status returns ok', async () => {
  const { status, body } = await get('/api/status')
  assert.strictEqual(status, 200)
  assert.ok('ok' in body)
})
