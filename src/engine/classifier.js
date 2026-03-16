const SAFE_TOOLS = new Set(['Read', 'Glob', 'Grep'])

const DESTRUCTIVE_BASH = [
  { pattern: /\brm\b.*(-r|-f|-rf|-fr)/i, severity: 'critical', reason: 'recursive/force file deletion' },
  { pattern: /\brmdir\b/i, severity: 'high', reason: 'directory deletion' },
  { pattern: /\bshred\b/i, severity: 'critical', reason: 'secure file deletion' },
  { pattern: /\btruncate\b\s+-s\s*0/i, severity: 'high', reason: 'file truncation to zero' },
  { pattern: /DROP\s+(TABLE|DATABASE|SCHEMA)/i, severity: 'critical', reason: 'SQL schema destruction' },
  { pattern: /TRUNCATE\s+TABLE/i, severity: 'high', reason: 'SQL data truncation' },
  { pattern: /\b(kill|killall|pkill|pkexec)\b/i, severity: 'high', reason: 'process termination' },
  { pattern: /\bgit\s+reset\s+--hard\b/i, severity: 'high', reason: 'destructive git reset' },
  { pattern: /\bgit\s+clean\s+-[a-z]*f/i, severity: 'high', reason: 'destructive git clean' },
  { pattern: /\bdd\s+if=/i, severity: 'critical', reason: 'raw disk write' },
  { pattern: /curl[^|]*\|\s*(ba)?sh/i, severity: 'high', reason: 'remote code execution' },
  { pattern: /wget[^|]*\|\s*(ba)?sh/i, severity: 'high', reason: 'remote code execution' },
  { pattern: /\bchmod\s+0*0+\b/i, severity: 'high', reason: 'permission lockout' },
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

  // Write/Edit/MultiEdit: destructive only if file exists
  // Checking file existence requires I/O — callers pass existsOnDisk flag
  if ((tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit') && input._existsOnDisk) {
    return { destructive: true, reason: 'overwriting existing file', severity: 'high' }
  }

  return { destructive: false, reason: 'safe operation', severity: null }
}
