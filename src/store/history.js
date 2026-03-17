import { getDb } from './db.js'

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000

/**
 * Strips large content fields before storing in the decisions audit log.
 * The chain always operates on the original unsanitized input object.
 * @param {string} tool
 * @param {object} input
 * @returns {object} sanitized input safe for storage
 */
export function sanitizeInput(tool, input) {
  if (tool === 'Write')
    return { file_path: input.file_path }
  if (tool === 'Edit')
    // new_string intentionally omitted — may be arbitrarily large.
    // file_path + truncated old_string are sufficient for audit purposes.
    return { file_path: input.file_path, old_string: input.old_string?.slice(0, 500) }
  if (tool === 'MultiEdit')
    return { file_path: input.file_path, edits_count: input.edits?.length }
  return input
}

/**
 * Logs a decision to the permanent audit log.
 * Sanitizes input before storage.
 * @param {object} opts
 * @param {string} opts.session_id
 * @param {string} opts.tool
 * @param {object} opts.input  — original unsanitized input
 * @param {string|null} opts.command
 * @param {string|null} opts.path
 * @param {string} opts.decision  — allow | deny | defer | ask
 * @param {string} opts.source    — user | rule | prediction | auto_afk | auto_defer | chain | notification
 * @param {number|null} opts.confidence
 * @param {string|null} opts.rule_id
 * @param {string|null} opts.reason
 * @param {string|null} opts.project_cwd
 * @returns {number} inserted row id
 */
export function logDecision(opts) {
  const db = getDb()
  const sanitized = sanitizeInput(opts.tool, opts.input)
  const result = db.prepare(`
    INSERT INTO decisions
      (ts, session_id, tool, input, command, path, decision, source, confidence, rule_id, reason, project_cwd)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    Date.now(),
    opts.session_id,
    opts.tool,
    JSON.stringify(sanitized),
    opts.command ?? null,
    opts.path ?? null,
    opts.decision,
    opts.source,
    opts.confidence ?? null,
    opts.rule_id ?? null,
    opts.reason ?? null,
    opts.project_cwd ?? null
  )
  return result.lastInsertRowid
}

/**
 * Queries decisions matching a tool + normalized pattern within the last 90 days.
 * Used by the predictor to compute confidence scores.
 * @param {object} opts
 * @param {string} opts.tool
 * @param {string} opts.pattern  — prefix to match against command/path (e.g. 'npm run')
 * @param {string} opts.project_cwd
 * @returns {Array<{ts: number, decision: string, confidence: number|null}>}
 */
export function queryByPattern({ tool, pattern, project_cwd }) {
  const db = getDb()
  const cutoff = Date.now() - NINETY_DAYS_MS
  return db.prepare(`
    SELECT ts, decision, confidence
    FROM decisions
    WHERE tool = ?
      AND (command LIKE ? OR path LIKE ?)
      AND project_cwd = ?
      AND ts >= ?
      AND decision != 'defer'
    ORDER BY ts DESC
    LIMIT 100
  `).all(tool, `${pattern}%`, `${pattern}%`, project_cwd, cutoff)
}

/**
 * Extracts a normalized pattern from a request for baseline tracking.
 * @param {object} request
 * @returns {string}
 */
export function extractPattern(request) {
  if (request.tool === 'Bash') {
    const cmd = request.input?.command ?? ''
    return cmd.split(' ').slice(0, 2).join(' ')
  }
  if (request.input?.file_path) {
    const parts = request.input.file_path.split('/')
    return parts.slice(0, -1).join('/') + '/*'
  }
  return request.tool
}

/**
 * Upserts the anomaly baseline for a request's tool+pattern in the current project.
 * Called after chain() returns, unconditionally, as a post-chain side effect.
 * @param {object} request
 */
export function updateBaseline(request) {
  const db = getDb()
  const pattern = extractPattern(request)
  const cwd = request.cwd ?? ''
  db.prepare(`
    INSERT INTO baselines (project_cwd, tool, pattern, count, last_seen)
    VALUES (?, ?, ?, 1, ?)
    ON CONFLICT(project_cwd, tool, pattern) DO UPDATE SET
      count = count + 1,
      last_seen = excluded.last_seen
  `).run(cwd, request.tool, pattern, Date.now())
}

/**
 * Returns a paginated list of decisions, optionally filtered.
 * @param {object} opts
 * @param {number} [opts.page=1]
 * @param {number} [opts.limit=50]
 * @param {string} [opts.tool]
 * @param {string} [opts.source]
 * @param {string} [opts.decision]
 * @param {string} [opts.date] — ISO date string (UTC calendar day filter)
 * @returns {{ items: object[], total: number, page: number, pages: number }}
 */
export function listDecisions({ page = 1, limit = 50, tool, source, decision, date } = {}) {
  const db = getDb()
  const cap = Math.min(Math.max(1, limit), 10000)
  const offset = (Math.max(1, page) - 1) * cap

  const conditions = []
  const params = []

  if (tool) { conditions.push('tool = ?'); params.push(tool) }
  if (source) { conditions.push('source = ?'); params.push(source) }
  if (decision) { conditions.push('decision = ?'); params.push(decision) }
  if (date) {
    const day = new Date(date)
    day.setUTCHours(0, 0, 0, 0)
    const start = day.getTime()
    const end = start + 86400000
    conditions.push('ts >= ? AND ts < ?')
    params.push(start, end)
  }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''

  const total = db.prepare(`SELECT COUNT(*) as c FROM decisions ${where}`).get(...params).c
  const items = db.prepare(
    `SELECT id, ts, tool, command, path, decision, source, confidence, reason
     FROM decisions ${where} ORDER BY ts DESC LIMIT ? OFFSET ?`
  ).all(...params, cap, offset)

  const pages = Math.max(1, Math.ceil(total / cap))
  return { items, total, page: Math.max(1, page), pages }
}

/**
 * Returns decision counts for the current UTC calendar day.
 * @returns {{ total: number, auto_approved: number, auto_denied: number, deferred: number }}
 */
export function getTodayStats() {
  const db = getDb()
  const start = new Date().setUTCHours(0, 0, 0, 0)
  const row = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN decision = 'allow' AND source != 'user' THEN 1 ELSE 0 END) as auto_approved,
      SUM(CASE WHEN decision = 'deny'  AND source != 'user' THEN 1 ELSE 0 END) as auto_denied,
      SUM(CASE WHEN decision = 'defer' THEN 1 ELSE 0 END) as deferred
    FROM decisions WHERE ts >= ?
  `).get(start)
  return {
    total:         row.total         ?? 0,
    auto_approved: row.auto_approved ?? 0,
    auto_denied:   row.auto_denied   ?? 0,
    deferred:      row.deferred      ?? 0
  }
}

/**
 * Returns aggregated decision stats over the last 90 days.
 * @returns {{ by_tool: object[], top_patterns: object[], by_source: object }}
 */
export function getDecisionStats() {
  const db = getDb()
  const cutoff = Date.now() - NINETY_DAYS_MS

  const by_tool = db.prepare(`
    SELECT tool,
           COUNT(*) as total,
           SUM(decision = 'allow') as allow,
           SUM(decision = 'deny')  as deny,
           SUM(decision = 'defer') as defer
    FROM decisions WHERE ts >= ?
    GROUP BY tool ORDER BY total DESC
  `).all(cutoff)

  const top_patterns = db.prepare(`
    SELECT tool,
           COALESCE(command, path, tool) as pattern,
           COUNT(*) as total,
           ROUND(AVG(decision = 'allow'), 2) as allow_rate
    FROM decisions WHERE ts >= ?
    GROUP BY tool, pattern ORDER BY total DESC LIMIT 20
  `).all(cutoff)

  const sourceRows = db.prepare(`
    SELECT source, COUNT(*) as count FROM decisions WHERE ts >= ? GROUP BY source
  `).all(cutoff)
  const by_source = Object.fromEntries(sourceRows.map(r => [r.source, r.count]))

  return { by_tool, top_patterns, by_source }
}
