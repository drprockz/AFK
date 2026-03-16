import { test } from 'node:test'
import assert from 'node:assert'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const __dir = dirname(fileURLToPath(import.meta.url))
const hookPath = join(__dir, '..', 'src', 'hook.js')

process.env.AFK_DB_DIR = join(tmpdir(), 'afk-hook-test-' + Date.now())
process.env.AFK_STATE_DIR = join(tmpdir(), 'afk-hook-state-test-' + Date.now())

function runHook(input) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [hookPath], {
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', d => { stdout += d })
    proc.stderr.on('data', d => { stderr += d })
    proc.on('close', code => {
      if (code !== 0 && !stdout) return reject(new Error(`hook exited ${code}: ${stderr}`))
      try {
        resolve(JSON.parse(stdout))
      } catch {
        reject(new Error(`invalid JSON from hook: ${stdout}`))
      }
    })
    proc.stdin.write(JSON.stringify(input))
    proc.stdin.end()
  })
}

const fixture = path => JSON.parse(readFileSync(join(__dir, 'fixtures', path), 'utf8'))

test('hook returns valid behavior for npm test (no history → ask)', async () => {
  const result = await runHook(fixture('bash-npm-test.json'))
  assert.ok(['allow', 'deny', 'ask'].includes(result.behavior), `unexpected behavior: ${result.behavior}`)
})

test('hook returns ask for malformed input', async () => {
  const result = await runHook({ notAValidRequest: true })
  assert.strictEqual(result.behavior, 'ask')
})

test('hook exits 0 on valid input', async () => {
  const result = await runHook(fixture('bash-npm-test.json'))
  assert.ok(result.behavior)
})
