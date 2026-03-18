import { getDb } from '../store/db.js'
import { randomUUID } from 'node:crypto'

const VALID_TOOLS = new Set(['Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'LS', '*'])
const VALID_ACTIONS = new Set(['allow', 'deny'])

/**
 * Converts a glob pattern (supporting * and ?) to a RegExp.
 * Falls back to substring match if the pattern contains no wildcards.
 * @param {string} pattern
 * @returns {RegExp}
 */
/**
 * Converts a glob pattern (supporting * and ?) to a RegExp.
 * @param {string} pattern
 * @param {boolean} [anchorStart=false] — when true, anchors to ^ so "npm *" matches
 *   "npm run build" but NOT "xnpm run build". Use for command (Bash) patterns.
 *   For file path patterns, leave false so "secret" matches "/app/secret.json".
 * @returns {RegExp}
 */
function patternToRegex(pattern, anchorStart = false) {
  // Escape regex metacharacters except * and ?
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  // Convert glob wildcards: * → .*, ? → .
  const regexStr = (anchorStart ? '^' : '') + escaped.replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(regexStr, 'i')
}

/**
 * Extracts the matchable string from a request's input based on tool type.
 * @param {string} tool
 * @param {object} input
 * @returns {string}
 */
function extractTarget(tool, input) {
  if (tool === 'Bash') return input.command ?? ''
  return input.file_path ?? input.pattern ?? input.path ?? ''
}

/**
 * Finds the highest-priority static rule matching this request.
 * Rules are evaluated in priority DESC order. First match wins.
 * Pattern matching: glob wildcards (* and ?) supported; falls back to substring match.
 * @param {object} opts
 * @param {string} opts.tool
 * @param {object} opts.input
 * @param {string} opts.cwd
 * @returns {object|null} matching rule row, or null
 */
export function matchRule({ tool, input, cwd }) {
  const db = getDb()
  const target = extractTarget(tool, input)

  const rows = db.prepare(`
    SELECT * FROM rules
    WHERE (tool = ? OR tool = '*')
      AND (project IS NULL OR project = ?)
    ORDER BY priority DESC
  `).all(tool, cwd)

  for (const row of rows) {
    // Anchor command rules so "npm *" matches "npm run build" but not "xnpm run build".
    // Path rules remain substring-matched so "secret" matches "/app/secret.json".
    const re = patternToRegex(row.pattern, row.tool === 'Bash')
    if (re.test(target)) {
      return row
    }
  }
  return null
}

/**
 * Adds a new static rule to the database.
 * @param {object} opts
 * @param {string} opts.tool  — Bash | Read | Write | Edit | MultiEdit | Glob | Grep | LS | *
 * @param {string} opts.pattern  — glob or literal substring
 * @param {string} opts.action  — allow | deny
 * @param {string} [opts.label]
 * @param {string} [opts.project]  — null = global
 * @param {number} [opts.priority]
 * @returns {string} new rule id
 */
export function addRule({ tool, pattern, action, label, project, priority = 0 }) {
  const normalizedAction = (action ?? '').toLowerCase()
  if (!VALID_ACTIONS.has(normalizedAction)) {
    throw new Error(`Invalid action "${action}": must be "allow" or "deny"`)
  }
  if (!VALID_TOOLS.has(tool)) {
    throw new Error(`Invalid tool "${tool}": must be one of ${[...VALID_TOOLS].join(', ')}`)
  }
  const db = getDb()
  const id = randomUUID()
  db.prepare(`
    INSERT INTO rules (id, created_ts, tool, pattern, action, label, project, priority)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, Date.now(), tool, pattern, normalizedAction, label ?? null, project ?? null, priority)
  return id
}

/**
 * Removes a rule by ID.
 * @param {string} id — full UUID
 * @returns {number} 1 if deleted, 0 if not found
 */
export function removeRule(id) {
  return getDb().prepare('DELETE FROM rules WHERE id = ?').run(id).changes
}

/**
 * Returns all rules, optionally filtered by project.
 * @param {string|null} [project]
 * @returns {object[]}
 */
export function listRules(project) {
  const db = getDb()
  if (project) {
    return db.prepare('SELECT * FROM rules WHERE project = ? OR project IS NULL ORDER BY priority DESC').all(project)
  }
  return db.prepare('SELECT * FROM rules ORDER BY priority DESC').all()
}

/**
 * Fetches a single rule by id.
 * @param {string} id — uuid
 * @returns {object|null} rule row or null if not found
 */
export function getRule(id) {
  const db = getDb()
  return db.prepare('SELECT * FROM rules WHERE id = ?').get(id) ?? null
}
