import { queryByPattern } from '../store/history.js'

/**
 * Extracts a normalized pattern from a request for querying history.
 * @param {string} tool
 * @param {object} input
 * @returns {string}
 */
function normalizePattern(tool, input) {
  if (tool === 'Bash') {
    const cmd = input.command ?? ''
    // Strip arguments after first two tokens: "npm run test --watch" → "npm run"
    return cmd.split(/\s+/).filter(Boolean).slice(0, 2).join(' ')
  }
  // Write/Read/Edit: strip filename, keep directory
  const path = input.file_path ?? input.path ?? ''
  const parts = path.split('/')
  return parts.slice(0, -1).join('/') + '/*'
}

/**
 * Predicts allow/deny based on historical decisions for this tool+pattern in this project.
 * Uses exponential recency weighting: recent decisions count more.
 * @param {object} opts
 * @param {string} opts.tool
 * @param {object} opts.input
 * @param {string} opts.cwd
 * @returns {{ confidence: number, predicted: 'allow'|'deny', sample_size: number, explanation: string }}
 */
export function predict({ tool, input, cwd }) {
  const pattern = normalizePattern(tool, input)
  const rows = queryByPattern({ tool, pattern, project_cwd: cwd })

  // Only count rows with explicit decisions (allow/deny) — 'ask' rows don't represent decisions
  const effectiveRows = rows.filter(r => r.decision !== 'ask')

  if (effectiveRows.length < 3) {
    return {
      confidence: 0.5,
      predicted: 'allow',
      sample_size: rows.length,
      explanation: `Insufficient history (${effectiveRows.length} effective samples) — cannot predict`
    }
  }

  const now = Date.now()
  const MS_PER_DAY = 24 * 60 * 60 * 1000

  let allowWeight = 0
  let totalWeight = 0

  for (const row of effectiveRows) {
    const daysOld = (now - row.ts) / MS_PER_DAY
    const weight = Math.exp(-daysOld / 30)  // half-life ~30 days
    totalWeight += weight
    if (row.decision === 'allow') allowWeight += weight
  }

  const confidence = totalWeight > 0 ? allowWeight / totalWeight : 0.5
  const predicted = confidence >= 0.5 ? 'allow' : 'deny'

  const approvals = effectiveRows.filter(r => r.decision === 'allow').length
  // Math.min gives oldest timestamp → now - oldest = span of data window = "last X days"
  const recentDays = Math.round((now - Math.min(...effectiveRows.map(r => r.ts))) / MS_PER_DAY)

  return {
    confidence,
    predicted,
    sample_size: rows.length,
    explanation: `${predicted === 'allow' ? 'Approved' : 'Denied'} ${approvals} of ${effectiveRows.length} similar ${tool} requests in the last ${recentDays} days`
  }
}
