const SENSITIVE_PATTERNS = [
  /\.env(\.|$)/i,
  /\.env\.(local|production|staging|development)/i,
  /secrets?\//i,
  /credentials?\//i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /id_rsa/i,
  /id_ed25519/i,
  /\.ssh\//i,
  /\.aws\/credentials/i,
  /\.npmrc/i,
  /\.netrc/i,
  /keystore/i,
  /vault/i,
  /api.?key/i,
  /access.?token/i,
  /auth.?token/i,
]

/**
 * Returns whether a PermissionRequest touches a sensitive path or value.
 * Sensitive requests always require user attention, regardless of AFK mode or rules.
 * @param {string} tool
 * @param {object} input
 * @returns {{ sensitive: boolean, matched: string | null }}
 */
export function isSensitive(tool, input) {
  const targets = []

  if (tool === 'Bash') {
    targets.push(input.command ?? '')
  } else {
    targets.push(input.file_path ?? '')
    targets.push(input.pattern ?? '')
    targets.push(input.path ?? '')
  }

  for (const target of targets) {
    for (const pattern of SENSITIVE_PATTERNS) {
      if (pattern.test(target)) {
        return { sensitive: true, matched: pattern.toString() }
      }
    }
  }

  return { sensitive: false, matched: null }
}
