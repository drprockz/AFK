import { getDb } from './db.js'

/**
 * Creates a session row if it does not already exist.
 * @param {string} sessionId
 * @param {string} projectCwd
 * @returns {{ created: boolean }}
 */
export function ensureSession(sessionId, projectCwd) {
  const db = getDb()
  const result = db.prepare(`
    INSERT OR IGNORE INTO sessions (id, started_ts, project_cwd)
    VALUES (?, ?, ?)
  `).run(sessionId, Date.now(), projectCwd)
  return { created: result.changes === 1 }
}

/**
 * Estimates token count for a request based on tool and input size.
 * @param {string} tool
 * @param {object} input
 * @returns {number} estimated tokens (integer, never NaN)
 */
export function estimateTokens(tool, input) {
  switch (tool) {
    case 'Bash':
      return Math.ceil((input.command?.length ?? 0) / 4) + 50
    case 'Write':
      return Math.ceil((input.content?.length ?? 0) / 4) + 50
    case 'Edit':
      return Math.ceil(((input.old_string?.length ?? 0) + (input.new_string?.length ?? 0)) / 4) + 50
    case 'Read':
    case 'Glob':
    case 'Grep':
    case 'LS':
    case 'Search':
      return 100
    default:
      return 100
  }
}

/**
 * Resolves the counter column to increment based on source+decision.
 * Column names are hardcoded — never derived from user input.
 * @param {string} decision
 * @param {string} source
 * @returns {string|null} column name or null for total_req only
 */
function resolveCounter(decision, source) {
  if (source === 'auto_afk') return 'auto_allow'
  if (source === 'auto_allow') return 'auto_allow'
  if (source === 'auto_defer' && decision === 'defer') return 'deferred'
  if (source === 'notification' && decision === 'deny') return 'auto_deny'
  if (source === 'user' && decision === 'allow') return 'user_allow'
  if (source === 'user' && decision === 'deny') return 'user_deny'
  if ((source === 'rule' || source === 'prediction' || source === 'chain') && decision === 'allow') return 'auto_allow'
  if ((source === 'rule' || source === 'prediction' || source === 'chain') && decision === 'deny') return 'auto_deny'
  return null
}

/**
 * Increments session stats for a single decision.
 * @param {string} sessionId
 * @param {string} decision — allow | deny | defer | ask
 * @param {string} source — rule | prediction | chain | auto_afk | auto_defer | notification | user
 */
export function updateSessionStats(sessionId, decision, source) {
  const db = getDb()
  const counter = resolveCounter(decision, source)
  if (counter) {
    // Allowed columns are hardcoded — counter comes from resolveCounter, not user input
    db.prepare(`UPDATE sessions SET total_req = total_req + 1, ${counter} = ${counter} + 1 WHERE id = ?`).run(sessionId)
  } else {
    db.prepare('UPDATE sessions SET total_req = total_req + 1 WHERE id = ?').run(sessionId)
  }
}

/**
 * Adds a token estimate to the session's running total.
 * @param {string} sessionId
 * @param {number} tokens
 */
export function addTokenEstimate(sessionId, tokens) {
  const db = getDb()
  db.prepare('UPDATE sessions SET tokens_est = tokens_est + ? WHERE id = ?').run(tokens, sessionId)
}

/**
 * Returns a single session by ID.
 * @param {string} sessionId
 * @returns {object|null}
 */
export function getSession(sessionId) {
  const db = getDb()
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) ?? null
}

/**
 * Returns a paginated list of sessions, most recent first.
 * @param {object} opts
 * @param {number} [opts.page=1]
 * @param {number} [opts.limit=20]
 * @returns {{ sessions: object[], total: number, page: number, limit: number }}
 */
export function listSessions({ page = 1, limit = 20 } = {}) {
  const db = getDb()
  const cap = Math.min(Math.max(1, limit), 1000)
  const offset = (Math.max(1, page) - 1) * cap
  const total = db.prepare('SELECT COUNT(*) as c FROM sessions').get().c
  const sessions = db.prepare(
    'SELECT * FROM sessions ORDER BY started_ts DESC LIMIT ? OFFSET ?'
  ).all(cap, offset)
  return { sessions, total, page: Math.max(1, page), limit: cap }
}

/**
 * Returns the most recently started session.
 * @returns {object|null}
 */
export function getMostRecentSession() {
  const db = getDb()
  return db.prepare('SELECT * FROM sessions ORDER BY started_ts DESC LIMIT 1').get() ?? null
}
