#!/usr/bin/env node
// scripts/afk-review-cli.js
import { spawn } from 'node:child_process'
import { createConnection } from 'node:net'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const serverScript = resolve(__dirname, '../src/dashboard/server.js')
const PORT = 6789

function isPortInUse(port) {
  return new Promise(resolve => {
    const conn = createConnection(port, '127.0.0.1')
    conn.on('connect', () => { conn.destroy(); resolve(true) })
    conn.on('error', () => resolve(false))
  })
}

const alreadyRunning = await isPortInUse(PORT)
if (!alreadyRunning) {
  const child = spawn(process.execPath, [serverScript], {
    detached: true,
    stdio: 'ignore'
  })
  child.unref()
  // Poll up to 3s for the server to bind
  let ready = false
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 200))
    if (await isPortInUse(PORT)) { ready = true; break }
  }
  if (!ready) {
    process.stderr.write('afk: dashboard server failed to start\n')
    process.exit(1)
  }
}

const url = `http://localhost:${PORT}`
const platform = process.platform
const [browserCmd, browserArgs] = platform === 'darwin' ? ['open', [url]]
                                : platform === 'win32'  ? ['cmd', ['/c', 'start', url]]
                                : ['xdg-open', [url]]
spawn(browserCmd, browserArgs, { stdio: 'ignore', detached: true }).unref()
console.log(`Dashboard: ${url}`)
