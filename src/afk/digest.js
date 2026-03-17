// src/afk/digest.js

/**
 * Builds a human-readable AFK session digest string.
 * Pure function — no I/O, no DB access.
 * @param {object[]} entries — digest entries (decision: 'allow' | 'defer'; others silently ignored)
 * @param {number} pendingCount — number of unreviewed deferred items in queue
 * @returns {string} formatted digest text
 */
export function buildDigest(entries, pendingCount) {
  const allowed = entries.filter(e => e.decision === 'allow')
  const deferred = entries.filter(e => e.decision === 'defer')

  // Guard: empty entries AND no pending queue items
  // Note: use entries.length (not allowed.length) so defer-only digests are not swallowed
  if (entries.length === 0 && pendingCount === 0) {
    return 'No activity during AFK session.'
  }

  const lines = []
  const total = allowed.length + Math.max(pendingCount, deferred.length)
  lines.push(`AFK session digest — ${total} actions while away`)
  lines.push('')

  if (allowed.length > 0) {
    // Group by tool; within each group collect unique labels (command or path)
    const byTool = {}
    for (const e of allowed) {
      if (!byTool[e.tool]) byTool[e.tool] = []
      byTool[e.tool].push(e.command ?? e.path ?? e.tool)
    }
    lines.push(`Auto-approved (${allowed.length}):`)
    for (const [tool, items] of Object.entries(byTool)) {
      const unique = [...new Set(items)]
      const shown = unique.slice(0, 3).join(', ')
      const extra = unique.length > 3 ? ` and ${unique.length - 3} more` : ''
      lines.push(`  • ${tool} ×${items.length} — ${shown}${extra}`)
    }
    lines.push('')
  }

  const effectivePending = Math.max(pendingCount, deferred.length)
  if (effectivePending > 0) {
    lines.push(`Deferred for your review (${effectivePending}):`)
    deferred.forEach((e, i) => {
      const label = e.command ?? e.path ?? e.tool
      lines.push(`  • [${i + 1}] ${e.tool}: ${label}`)
    })
    if (deferred.length === 0 && pendingCount > 0) {
      lines.push(`  (${pendingCount} item(s) pending — run /afk off to review)`)
    }
    lines.push('')
  }

  lines.push('Run /afk:review to process deferred items in the dashboard (Phase 6).')
  return lines.join('\n')
}
