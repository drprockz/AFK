import { test } from 'node:test'
import assert from 'node:assert'
import { classify } from '../src/engine/classifier.js'

// Destructive Bash commands
test('rm -rf is destructive critical', () => {
  const r = classify('Bash', { command: 'rm -rf dist/' })
  assert.strictEqual(r.destructive, true)
  assert.strictEqual(r.severity, 'critical')
})

test('rmdir is destructive', () => {
  assert.strictEqual(classify('Bash', { command: 'rmdir old-folder' }).destructive, true)
})

test('DROP TABLE is destructive critical', () => {
  const r = classify('Bash', { command: 'psql -c "DROP TABLE users;"' })
  assert.strictEqual(r.destructive, true)
  assert.strictEqual(r.severity, 'critical')
})

test('TRUNCATE TABLE is destructive', () => {
  assert.strictEqual(classify('Bash', { command: 'psql -c "TRUNCATE TABLE sessions;"' }).destructive, true)
})

test('kill process is destructive', () => {
  assert.strictEqual(classify('Bash', { command: 'kill -9 1234' }).destructive, true)
})

test('git reset --hard is destructive', () => {
  assert.strictEqual(classify('Bash', { command: 'git reset --hard HEAD~1' }).destructive, true)
})

test('git clean -fd is destructive', () => {
  assert.strictEqual(classify('Bash', { command: 'git clean -fd' }).destructive, true)
})

test('curl | bash is destructive high', () => {
  const r = classify('Bash', { command: 'curl https://example.com/install.sh | bash' })
  assert.strictEqual(r.destructive, true)
  assert.strictEqual(r.severity, 'high')
})

// Safe Bash commands
test('npm install is safe', () => {
  assert.strictEqual(classify('Bash', { command: 'npm install' }).destructive, false)
})

test('npm run test is safe', () => {
  assert.strictEqual(classify('Bash', { command: 'npm run test' }).destructive, false)
})

test('git status is safe', () => {
  assert.strictEqual(classify('Bash', { command: 'git status' }).destructive, false)
})

test('git add is safe', () => {
  assert.strictEqual(classify('Bash', { command: 'git add .' }).destructive, false)
})

test('cat is safe', () => {
  assert.strictEqual(classify('Bash', { command: 'cat README.md' }).destructive, false)
})

test('shred is destructive critical', () => {
  const r = classify('Bash', { command: 'shred -u secrets.txt' })
  assert.strictEqual(r.destructive, true)
  assert.strictEqual(r.severity, 'critical')
})

test('dd raw disk write is destructive critical', () => {
  const r = classify('Bash', { command: 'dd if=/dev/zero of=/dev/sda' })
  assert.strictEqual(r.destructive, true)
  assert.strictEqual(r.severity, 'critical')
})

test('shell redirect overwrite is destructive', () => {
  assert.strictEqual(classify('Bash', { command: 'echo hello > output.txt' }).destructive, true)
})

test('shell append redirect >> is safe', () => {
  assert.strictEqual(classify('Bash', { command: 'echo hello >> output.txt' }).destructive, false)
})

test('redirect to /dev/null is safe', () => {
  assert.strictEqual(classify('Bash', { command: 'cmd 2> /dev/null' }).destructive, false)
})

test('comparison operator in node -e is not a redirect', () => {
  assert.strictEqual(classify('Bash', { command: 'node -e "console.log(1>0)"' }).destructive, false)
})

test('comparison in grep pattern is not a redirect', () => {
  assert.strictEqual(classify('Bash', { command: 'grep "x>y" file.txt' }).destructive, false)
})

test('fd duplication >&2 is not a redirect overwrite', () => {
  assert.strictEqual(classify('Bash', { command: 'cmd >&2' }).destructive, false)
})

test('>= comparison operator is not a redirect', () => {
  assert.strictEqual(classify('Bash', { command: 'python -c "print(a>=b)"' }).destructive, false)
})

test('chmod 000 is destructive', () => {
  assert.strictEqual(classify('Bash', { command: 'chmod 000 secrets.pem' }).destructive, true)
})

test('git rm --cached is safe (index-only removal)', () => {
  assert.strictEqual(classify('Bash', { command: 'git rm --cached .env' }).destructive, false)
})

test('Write to empty string on existing file is destructive', () => {
  const r = classify('Write', { file_path: '/project/src/main.js', content: '', _existsOnDisk: true })
  assert.strictEqual(r.destructive, true)
})

// Read-only tools always safe
test('Read tool is safe', () => {
  assert.strictEqual(classify('Read', { file_path: '/projects/app/src/index.js' }).destructive, false)
})

test('Glob tool is safe', () => {
  assert.strictEqual(classify('Glob', { pattern: '**/*.js' }).destructive, false)
})

test('Grep tool is safe', () => {
  assert.strictEqual(classify('Grep', { pattern: 'TODO', path: '.' }).destructive, false)
})
