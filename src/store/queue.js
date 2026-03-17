// src/store/queue.js
import { getDb } from './db.js'

/**
 * Inserts a new deferred item into the queue.
 * Truncates input.content to 5000 chars if present (prevents SQLite bloat from Write/Edit tools).
 * @param {object} opts
 * @param {number} opts.decisionsId — FK to decisions.id of the originating defer row
 * @param {string} opts.sessionId
 * @param {string} opts.tool
 * @param {object} opts.input — original request input (unsanitized, for human review)
 * @param {string|null} opts.command
 * @param {string|null} opts.path
 * @returns {number} new deferred row id
 */
export function enqueueDeferred({ decisionsId, sessionId, tool, input, command, path }) {
  const db = getDb()
  // Size-cap: Write/Edit inputs can carry megabytes of file content
  const safeInput = (typeof input.content === 'string' && input.content.length > 5000)
    ? { ...input, content: input.content.slice(0, 5000) + '...[truncated]' }
    : input
  const result = db.prepare(`
    INSERT INTO deferred (ts, session_id, tool, input, command, path, decisions_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(Date.now(), sessionId, tool, JSON.stringify(safeInput), command ?? null, path ?? null, decisionsId)
  return result.lastInsertRowid
}

/**
 * Returns all unreviewed deferred items, oldest first.
 * @returns {Array<object>} deferred rows with reviewed=0
 */
export function getPendingItems() {
  const db = getDb()
  return db.prepare(`
    SELECT * FROM deferred WHERE reviewed = 0 ORDER BY ts ASC
  `).all()
}

/**
 * Marks a deferred item as reviewed with a final decision.
 * @param {number} id — deferred row id
 * @param {'allow'|'deny'} final
 * @returns {boolean} true if row was updated, false if id did not exist
 */
export function resolveItem(id, final) {
  const db = getDb()
  const result = db.prepare(`
    UPDATE deferred SET reviewed = 1, final = ?, review_ts = ? WHERE id = ?
  `).run(final, Date.now(), id)
  return result.changes > 0
}

/**
 * Returns the count of unreviewed deferred items.
 * @returns {number}
 */
export function getPendingCount() {
  const db = getDb()
  return db.prepare(`SELECT COUNT(*) as c FROM deferred WHERE reviewed = 0`).get().c
}

/**
 * Fetches a single deferred row by id.
 * @param {number} id
 * @returns {object|null} deferred row or null if not found
 */
export function getItemById(id) {
  const db = getDb()
  return db.prepare('SELECT * FROM deferred WHERE id = ?').get(id) ?? null
}
