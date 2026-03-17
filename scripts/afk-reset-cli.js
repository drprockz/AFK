#!/usr/bin/env node
// scripts/afk-reset-cli.js
import { createInterface } from 'node:readline'
import { getDb } from '../src/store/db.js'

const rl = createInterface({ input: process.stdin, output: process.stdout })
rl.question("Type 'reset' to confirm (this cannot be undone): ", answer => {
  rl.close()
  if (answer.trim() !== 'reset') {
    console.log('Cancelled.')
    process.exit(0)
  }
  const db = getDb()
  const doReset = db.transaction(() => ({
    d: db.prepare('DELETE FROM decisions').run().changes,
    s: db.prepare('DELETE FROM sessions').run().changes,
    q: db.prepare('DELETE FROM deferred').run().changes,
    b: db.prepare('DELETE FROM baselines').run().changes,
  }))
  const { d, s, q, b } = doReset()
  console.log(`\nReset complete:`)
  console.log(`  decisions:  ${d} rows deleted`)
  console.log(`  sessions:   ${s} rows deleted`)
  console.log(`  deferred:   ${q} rows deleted`)
  console.log(`  baselines:  ${b} rows deleted`)
  console.log(`\nRules and config preserved.`)
})
