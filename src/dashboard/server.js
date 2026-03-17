// src/dashboard/server.js
import express from 'express'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import apiRouter from './api.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

let _server = null

/**
 * Starts the dashboard HTTP server bound to 127.0.0.1.
 * Idempotent — no-op if already running in this process.
 * @param {number} [port=6789]
 */
export function startServer(port = 6789) {
  if (_server) return
  const app = express()
  app.use(express.json())
  app.use('/api', apiRouter)
  app.use(express.static(join(__dirname, 'ui')))
  _server = createServer(app)
  _server.listen(port, '127.0.0.1', () => {
    // server running
  })
  _server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      process.stderr.write(`afk dashboard: port ${port} already in use\n`)
      _server = null
    } else {
      process.stderr.write(`afk dashboard error: ${err.message}\n`)
    }
  })
}

/**
 * Closes the server (used in tests for teardown).
 * @returns {Promise<void>}
 */
export function stopServer() {
  return new Promise(resolve => {
    if (!_server) return resolve()
    _server.close(() => { _server = null; resolve() })
  })
}

// Standalone mode: node src/dashboard/server.js
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startServer()
}
