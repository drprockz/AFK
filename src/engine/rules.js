import { getDb } from '../store/db.js'
import { randomUUID } from 'node:crypto'

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
    if (target.includes(row.pattern)) {
      return row
    }
  }
  return null
}

/**
 * Adds a new static rule to the database.
 * @param {object} opts
 * @param {string} opts.tool
 * @param {string} opts.pattern
 * @param {string} opts.action  — allow | deny
 * @param {string} [opts.label]
 * @param {string} [opts.project]  — null = global
 * @param {number} [opts.priority]
 * @returns {string} new rule id
 */
export function addRule({ tool, pattern, action, label, project, priority = 0 }) {
  const db = getDb()
  const id = randomUUID()
  db.prepare(`
    INSERT INTO rules (id, created_ts, tool, pattern, action, label, project, priority)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, Date.now(), tool, pattern, action, label ?? null, project ?? null, priority)
  return id
}

/**
 * Removes a rule by ID.
 * @param {string} id
 */
export function removeRule(id) {
  getDb().prepare('DELETE FROM rules WHERE id = ?').run(id)
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
