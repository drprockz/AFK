// src/dashboard/api.js
import express from 'express'
import { listDecisions, getTodayStats, getDecisionStats } from '../store/history.js'
import { getPendingItems, getPendingCount, resolveItem, getItemById } from '../store/queue.js'
import { addRule, removeRule, listRules, getRule } from '../engine/rules.js'
import { getState, setAfk } from '../afk/state.js'
import { buildDigest } from '../afk/digest.js'
import { loadConfig } from '../notify/config.js'
import { notify } from '../notify/notify.js'

const router = express.Router()

// ── GET /api/status ──────────────────────────────────────────────────────────
router.get('/status', (_req, res) => {
  const state = getState()
  const today = getTodayStats()
  const queue_count = getPendingCount()
  const auto_rate = today.total > 0
    ? Math.round(today.auto_approved / today.total * 100)
    : 0
  res.json({
    ok:          true,
    afk:         state.afk,
    afk_since:   state.afk_since  ?? null,
    afk_until:   state.afk_until  ?? null,
    session_id:  state.session_id ?? null,
    project_cwd: process.cwd(),
    queue_count,
    today: { ...today, auto_rate }
  })
})

// ── GET /api/decisions ────────────────────────────────────────────────────────
router.get('/decisions', (req, res) => {
  const { page, limit, tool, source, decision, date } = req.query
  const result = listDecisions({
    page:     page     ? Number(page)  : 1,
    limit:    limit    ? Number(limit) : 50,
    tool:     tool     || undefined,
    source:   source   || undefined,
    decision: decision || undefined,
    date:     date     || undefined
  })
  res.json(result)
})

// ── GET /api/queue ────────────────────────────────────────────────────────────
router.get('/queue', (_req, res) => {
  res.json(getPendingItems())
})

// ── POST /api/queue/:id ───────────────────────────────────────────────────────
router.post('/queue/:id', async (req, res) => {
  const { action } = req.body ?? {}
  if (action !== 'allow' && action !== 'deny') {
    return res.status(400).json({ error: 'invalid action — must be allow or deny' })
  }
  const id = Number(req.params.id)
  const row = getItemById(id)
  resolveItem(id, action)
  // fire-and-forget notification
  try {
    const config = loadConfig()
    if (config?.notifications?.provider) {
      const deadline = Date.now() + (config.notifications?.timeout ?? 5) * 1000
      notify(config, {
        tool:      row?.tool      ?? 'unknown',
        command:   row?.command   ?? null,
        path:      row?.path      ?? null,
        requestId: String(id)
      }, deadline).catch(err => process.stderr.write(`afk notify: ${err.message}\n`))
    }
  } catch { /* ignore notify errors */ }
  res.json({ id, final: action, review_ts: Date.now() })
})

// ── GET /api/rules ────────────────────────────────────────────────────────────
router.get('/rules', (_req, res) => {
  res.json(listRules(null))
})

// ── POST /api/rules ───────────────────────────────────────────────────────────
router.post('/rules', (req, res) => {
  const { tool, pattern, action, label, project, priority } = req.body ?? {}
  for (const field of ['tool', 'pattern', 'action']) {
    if (!req.body?.[field]) {
      return res.status(400).json({ error: `missing field: ${field}` })
    }
  }
  const id = addRule({ tool, pattern, action, label, project, priority })
  res.json(getRule(id))
})

// ── DELETE /api/rules/:id ─────────────────────────────────────────────────────
router.delete('/rules/:id', (req, res) => {
  removeRule(req.params.id)
  res.json({ deleted: true })
})

// ── GET /api/stats ────────────────────────────────────────────────────────────
router.get('/stats', (_req, res) => {
  res.json(getDecisionStats())
})

// ── GET /api/digest ───────────────────────────────────────────────────────────
router.get('/digest', (_req, res) => {
  const state = getState()
  const entries = state.digest ?? []
  const pendingCount = getPendingCount()
  res.json({ digest: buildDigest(entries, pendingCount) })
})

// ── POST /api/afk ─────────────────────────────────────────────────────────────
router.post('/afk', (req, res) => {
  const { on, duration } = req.body ?? {}
  setAfk(Boolean(on), duration ?? undefined)
  res.json(getState())
})

// ── GET /api/export ───────────────────────────────────────────────────────────
router.get('/export', (req, res) => {
  const format = req.query.format === 'csv' ? 'csv' : 'json'
  const { items } = listDecisions({ limit: 10000 })
  if (format === 'csv') {
    res.setHeader('Content-Disposition', 'attachment; filename="afk-decisions.csv"')
    res.setHeader('Content-Type', 'text/csv')
    const header = 'id,ts,tool,command,path,decision,source,confidence'
    const rows = items.map(i =>
      [i.id, i.ts, i.tool, i.command ?? '', i.path ?? '', i.decision, i.source, i.confidence ?? ''].join(',')
    )
    res.send([header, ...rows].join('\n'))
  } else {
    res.setHeader('Content-Disposition', 'attachment; filename="afk-decisions.json"')
    res.json(items)
  }
})

export default router
