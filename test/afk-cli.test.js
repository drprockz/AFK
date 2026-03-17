import { test } from 'node:test'
import assert from 'node:assert'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'

const execFileAsync = promisify(execFile)
const __dir = dirname(fileURLToPath(import.meta.url))
const CLI = join(__dir, '..', 'scripts', 'afk-cli.js')

// Each test gets isolated state and DB dirs
function makeEnv() {
  return {
    ...process.env,
    AFK_STATE_DIR: mkdtempSync(join(tmpdir(), 'afk-cli-state-')),
    AFK_DB_DIR: mkdtempSync(join(tmpdir(), 'afk-cli-db-'))
  }
}

async function run(args, env) {
  const { stdout } = await execFileAsync('node', [CLI, ...args], { env })
  return stdout
}

/**
 * Directly inserts a decisions + deferred row into the isolated DB.
 * Returns the deferred row id for use in resolve tests.
 */
function insertTestDeferredItem(dbDir) {
  mkdirSync(dbDir, { recursive: true })
  const db = new Database(join(dbDir, 'afk.db'))
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE IF NOT EXISTS decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL,
      session_id TEXT NOT NULL, tool TEXT NOT NULL, input TEXT NOT NULL,
      command TEXT, path TEXT, decision TEXT NOT NULL, source TEXT NOT NULL,
      confidence REAL, rule_id TEXT, reason TEXT, project_cwd TEXT
    );
    CREATE TABLE IF NOT EXISTS deferred (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL,
      session_id TEXT NOT NULL, tool TEXT NOT NULL, input TEXT NOT NULL,
      command TEXT, path TEXT, decisions_id INTEGER NOT NULL,
      reviewed INTEGER DEFAULT 0, final TEXT, review_ts INTEGER
    );
  `)
  const dr = db.prepare(
    'INSERT INTO decisions (ts,session_id,tool,input,command,path,decision,source,project_cwd) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(Date.now(), 's1', 'Bash', '{"command":"rm -rf dist/"}', 'rm -rf dist/', null, 'defer', 'auto_defer', '/test')
  const qr = db.prepare(
    'INSERT INTO deferred (ts,session_id,tool,input,command,path,decisions_id) VALUES (?,?,?,?,?,?,?)'
  ).run(Date.now(), 's1', 'Bash', '{"command":"rm -rf dist/"}', 'rm -rf dist/', null, dr.lastInsertRowid)
  db.close()
  return qr.lastInsertRowid
}

test('status prints current AFK state without crashing', async () => {
  const out = await run(['status'], makeEnv())
  assert.ok(out.includes('AFK mode:'), 'should include AFK mode line')
})

test('on enables AFK and prints confirmation', async () => {
  const env = makeEnv()
  const out = await run(['on'], env)
  assert.ok(out.includes('ON'), 'output should mention ON')
})

test('off disables AFK and prints digest', async () => {
  const env = makeEnv()
  await run(['on'], env)           // turn on first
  const out = await run(['off'], env)
  assert.ok(out.includes('AFK mode: OFF'), 'should confirm AFK is off')
  assert.ok(out.includes('AFK session digest') || out.includes('No activity'), 'should show digest or no-activity message')
})

test('resolve with existing id prints resolved confirmation', async () => {
  const env = makeEnv()
  const id = insertTestDeferredItem(env.AFK_DB_DIR)
  const out = await run(['resolve', String(id), 'allow'], env)
  assert.ok(out.includes(`Resolved [id=${id}]: allow.`), 'should print resolution confirmation')
})

test('resolve with non-existent id prints not-found message', async () => {
  const env = makeEnv()
  const out = await run(['resolve', '99999', 'allow'], env)
  assert.ok(out.includes('No pending item with id 99999'), 'should report missing id')
})
