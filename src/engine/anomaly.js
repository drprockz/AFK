// src/engine/anomaly.js
import { getDb } from '../store/db.js'
import { extractPattern } from '../store/history.js'

const ANOMALY_THRESHOLD = 0.7

const SUSPICIOUS_PREFIXES = ['/etc/', '/usr/', '/var/', '/root/', '/home/', '/tmp/', '~/']

/**
 * Detects whether a PermissionRequest is statistically anomalous for this project.
 * Checks the baselines table frequency and (for Bash) scans for outside-cwd paths.
 * Never throws — returns a safe fallback on any DB or logic error.
 * @param {object} request  — { tool, input, cwd }
 * @returns {{ anomalous: boolean, score: number, reason: string }}
 */
export function detectAnomaly(request) {
  try {
    const db = getDb()
    const pattern = extractPattern(request)
    const cwd = request.cwd ?? ''

    // ── Minimum baseline check ──────────────────────────────────────────────
    // On fresh installs, every command is "never seen" → score 1.0 → everything
    // gets flagged as anomalous. Skip anomaly detection until we have enough data.
    const totalBaselines = db.prepare(
      `SELECT COALESCE(SUM(count), 0) AS total FROM baselines WHERE project_cwd = ?`
    ).get(cwd)?.total ?? 0
    if (totalBaselines < 10) {
      return { anomalous: false, score: 0, reason: 'insufficient baseline data (fresh install)' }
    }

    // ── Frequency signal ────────────────────────────────────────────────────
    const row = db.prepare(`
      SELECT count FROM baselines
      WHERE project_cwd = ? AND tool = ? AND pattern = ?
    `).get(cwd, request.tool, pattern)

    let score
    let reason
    if (!row) {
      score = 1.0
      reason = `never seen in this project (pattern: ${pattern})`
    } else if (row.count <= 2) {
      score = 0.7
      reason = `seen rarely (${row.count} time${row.count === 1 ? '' : 's'})`
    } else if (row.count <= 9) {
      score = 0.3
      reason = `seen occasionally (${row.count} times)`
    } else {
      score = 0.0
      reason = `common pattern (${row.count} times)`
    }

    // ── Outside-cwd signal (Bash only) ──────────────────────────────────────
    if (request.tool === 'Bash' && request.input?.command) {
      const tokens = request.input.command.split(/\s+/)
      for (const token of tokens) {
        const isSuspicious = SUSPICIOUS_PREFIXES.some(prefix => token.startsWith(prefix))
        const isInsideCwd = cwd && token.startsWith(cwd)
        if (isSuspicious && !isInsideCwd) {
          score = Math.max(score, 0.8)
          reason = `accesses path outside project: ${token}`
          break
        }
      }
    }

    return {
      anomalous: score >= ANOMALY_THRESHOLD,
      score,
      reason
    }
  } catch {
    return { anomalous: false, score: 0, reason: 'anomaly check skipped (error)' }
  }
}
