#!/usr/bin/env node
// scripts/afk-review-cli.js
import { spawn, execSync } from 'node:child_process'
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
  // brief pause to let server bind
  await new Promise(r => setTimeout(r, 300))
}

const url = `http://localhost:${PORT}`
const cmd = process.platform === 'darwin' ? `open "${url}"`
          : process.platform === 'win32'  ? `start "${url}"`
          : `xdg-open "${url}"`
try {
  execSync(cmd)
  console.log(`Dashboard: ${url}`)
} catch {
  console.log(`Dashboard running at: ${url}`)
}
