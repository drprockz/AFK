#!/usr/bin/env node
// scripts/afk-stats-cli.js
import { getTodayStats, getDecisionStats } from '../src/store/history.js'
import { getPendingCount } from '../src/store/queue.js'
import { isAfk } from '../src/afk/state.js'

const today   = getTodayStats()
const stats   = getDecisionStats()
const pending = getPendingCount()
const afkOn   = isAfk()

const userReviewed = today.total - today.auto_approved - today.auto_denied - today.deferred
const autoRate     = today.total > 0 ? Math.round(today.auto_approved / today.total * 100) : 0
const denyRate     = today.total > 0 ? Math.round(today.auto_denied   / today.total * 100) : 0

console.log('\nAFK Stats — today')
console.log(`  Total requests:    ${today.total}`)
console.log(`  Auto-approved:     ${today.auto_approved} (${autoRate}%)`)
console.log(`  Auto-denied:       ${today.auto_denied} (${denyRate}%)`)
console.log(`  User-reviewed:     ${Math.max(0, userReviewed)}`)
console.log(`  Deferred (queue):  ${pending} pending`)
console.log(`  AFK mode:          ${afkOn ? 'ON' : 'OFF'}`)

const top3 = stats.top_patterns.filter(p => p.allow_rate > 0.5).slice(0, 3)
if (top3.length > 0) {
  console.log('\nTop auto-approved patterns:')
  top3.forEach((p, i) => {
    console.log(`  ${i+1}. ${p.tool}: ${p.pattern} (${Math.round(p.allow_rate * 100)}% allow)`)
  })
}
console.log()
