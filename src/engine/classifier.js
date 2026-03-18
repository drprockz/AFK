const SAFE_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS'])

const DESTRUCTIVE_BASH = [
  // rm invocation — excludes "git rm --cached" which only removes from index, not disk
  { pattern: /(?<!git\s)\brm\b(?!\s+--cached)/i, severity: 'critical', reason: 'file deletion' },
  { pattern: /\brmdir\b/i, severity: 'high', reason: 'directory deletion' },
  { pattern: /\bshred\b/i, severity: 'critical', reason: 'secure file deletion' },
  { pattern: /\btruncate\b\s+-s\s*0/i, severity: 'high', reason: 'file truncation to zero' },
  // Shell redirect overwrite: requires whitespace before > to avoid false-positives on
  // comparison operators like 1>0, x>y or HTML in strings. Excludes >>, >=, >&(fd dup).
  { pattern: /(?<=\s)(?:\d+)?(?<![>])>(?![>=&])\s*(?!\/dev\/null)\S/, severity: 'high', reason: 'shell redirect overwriting file' },
  { pattern: /DROP\s+(TABLE|DATABASE|SCHEMA)/i, severity: 'critical', reason: 'SQL schema destruction' },
  { pattern: /TRUNCATE\s+TABLE/i, severity: 'high', reason: 'SQL data truncation' },
  { pattern: /\b(kill|killall|pkill|pkexec)\b/i, severity: 'high', reason: 'process termination' },
  { pattern: /\bgit\s+reset\s+--hard\b/i, severity: 'high', reason: 'destructive git reset' },
  // git clean with -f or --force in any flag combination, case-insensitive
  { pattern: /\bgit\s+clean\s+.*(-[a-zA-Z]*[fF]|--force)/i, severity: 'high', reason: 'destructive git clean' },
  { pattern: /\bdd\s+if=/i, severity: 'critical', reason: 'raw disk write' },
  { pattern: /curl[^|]*\|\s*(ba)?sh/i, severity: 'high', reason: 'remote code execution' },
  { pattern: /wget[^|]*\|\s*(ba)?sh/i, severity: 'high', reason: 'remote code execution' },
  // chmod: numeric all-zero OR symbolic total removal OR --recursive
  { pattern: /\bchmod\b.*(0{3,4}|a[-=]rwx|u[-=]rwx.*g[-=]rwx|--recursive.*[0-7]{3})/i, severity: 'high', reason: 'permission lockout' },
]

/**
 * Classifies a PermissionRequest as destructive or safe.
 * Pure logic — no I/O.
 * @param {string} tool
 * @param {object} input
 * @returns {{ destructive: boolean, reason: string, severity: 'critical'|'high'|'medium'|null }}
 */
export function classify(tool, input) {
  if (SAFE_TOOLS.has(tool)) {
    return { destructive: false, reason: 'read-only tool', severity: null }
  }

  if (tool === 'Bash') {
    const cmd = input.command ?? ''
    for (const { pattern, severity, reason } of DESTRUCTIVE_BASH) {
      if (pattern.test(cmd)) {
        return { destructive: true, reason, severity }
      }
    }
    return { destructive: false, reason: 'safe bash command', severity: null }
  }

  // Edit/MultiEdit: destructive only if removing a large block of content (>50 lines)
  if (tool === 'Edit' || tool === 'MultiEdit') {
    const edits = tool === 'MultiEdit' ? (input.edits ?? []) : [input]
    for (const edit of edits) {
      const removed = (edit.old_string ?? '').split('\n').length
      const added = (edit.new_string ?? '').split('\n').length
      if (removed > 50 && added < removed * 0.5) {
        return { destructive: true, reason: `large deletion (${removed} lines removed)`, severity: 'high' }
      }
    }
    return { destructive: false, reason: 'normal file edit', severity: null }
  }

  // Write: destructive only if writing very little content to an existing file
  // (likely emptying it). Normal writes — including full file rewrites — are safe.
  if (tool === 'Write' && input._existsOnDisk) {
    const lines = (input.content ?? '').split('\n').length
    if (lines <= 1 && (input.content ?? '').trim().length === 0) {
      return { destructive: true, reason: 'truncating existing file to empty', severity: 'high' }
    }
    return { destructive: false, reason: 'normal file write', severity: null }
  }

  return { destructive: false, reason: 'safe operation', severity: null }
}
