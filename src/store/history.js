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
