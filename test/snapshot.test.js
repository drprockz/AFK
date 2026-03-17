import { test } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// snapshot.js uses node:child_process directly — no DB, no AFK state
const { snapshot } = await import('../src/safety/snapshot.js')

function makeTempGitRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'afk-snap-'))
  execFileSync('git', ['init'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  // Create an empty initial commit so snapshot commits are never root-commits.
  // Root-commit output includes "(root-commit)" which breaks hash parsing:
  //   [main (root-commit) abc1234] → regex fails to extract hash
  execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: dir })
  return dir
}

test('returns snapshotted=true with commit hash when repo has changes', async () => {
  const dir = makeTempGitRepo()
  writeFileSync(join(dir, 'work.txt'), 'some work')
  const result = await snapshot(dir, 'rm -rf dist/')
  assert.strictEqual(result.snapshotted, true)
  assert.ok(typeof result.commit === 'string' && result.commit.length > 0, 'commit hash must be a non-empty string')
  assert.ok(/^[0-9a-f]{7,}$/.test(result.commit), `commit must be a hex hash, got: "${result.commit}"`)
})

test('returns snapshotted=false when working tree is clean', async () => {
  const dir = makeTempGitRepo()
  // makeTempGitRepo() already creates an empty initial commit — tree is already clean
  const result = await snapshot(dir, 'test reason')
  assert.strictEqual(result.snapshotted, false)
  assert.strictEqual(result.commit, null)
})

test('returns snapshotted=false when cwd is not a git repo', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'afk-nogit-'))
  const result = await snapshot(dir, 'test reason')
  assert.strictEqual(result.snapshotted, false)
  assert.strictEqual(result.commit, null)
})

test('never throws — returns gracefully on git failure', async () => {
  // Pass a non-existent path — git will fail
  const result = await snapshot('/non/existent/path/xyz', 'test')
  assert.strictEqual(result.snapshotted, false)
  assert.strictEqual(result.commit, null)
})
