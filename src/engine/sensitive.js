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
  // Tightened: require word boundary + secret operation context to avoid matching
  // "vault" in app names, filenames, or variable names like VaultIcon.tsx
  /\bvault\b.*(secrets?|login|token|unseal|kv)/i,
  // Tightened: match only when surrounded by non-alphanumeric chars (word boundaries)
  // to avoid matching source files like api_key_validator.js or token_refresh.ts
  /\bapi[_\-.]?key\b/i,
  /\baccess[_\-.]?token\b/i,
  /\bauth[_\-.]?token\b/i,
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
