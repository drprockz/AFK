import { test } from 'node:test'
import assert from 'node:assert'
import { isSensitive } from '../src/engine/sensitive.js'

test('Read .env is sensitive', () => {
  const r = isSensitive('Read', { file_path: '/projects/app/.env' })
  assert.strictEqual(r.sensitive, true)
  assert.ok(r.matched)
})

test('Read .env.local is sensitive', () => {
  assert.strictEqual(isSensitive('Read', { file_path: '.env.local' }).sensitive, true)
})

test('Read .env.production is sensitive', () => {
  assert.strictEqual(isSensitive('Read', { file_path: '/app/.env.production' }).sensitive, true)
})

test('Write to id_rsa is sensitive', () => {
  assert.strictEqual(isSensitive('Write', { file_path: '/home/user/.ssh/id_rsa' }).sensitive, true)
})

test('Read ~/.aws/credentials is sensitive', () => {
  assert.strictEqual(isSensitive('Read', { file_path: '/home/user/.aws/credentials' }).sensitive, true)
})

test('Read ~/.npmrc is sensitive', () => {
  assert.strictEqual(isSensitive('Read', { file_path: '/home/user/.npmrc' }).sensitive, true)
})

test('Bash with no path is not sensitive', () => {
  assert.strictEqual(isSensitive('Bash', { command: 'npm install' }).sensitive, false)
})

test('Read regular source file is not sensitive', () => {
  assert.strictEqual(isSensitive('Read', { file_path: '/projects/app/src/index.js' }).sensitive, false)
})

test('Bash touching api_key variable in command is sensitive', () => {
  const r = isSensitive('Bash', { command: 'echo $API_KEY > output.txt' })
  assert.strictEqual(r.sensitive, true)
})
