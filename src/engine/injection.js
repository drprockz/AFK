const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions?/i,
  /disregard\s+(all\s+)?(previous\s+)?instructions?/i,
  /new\s+system\s+prompt/i,
  // Tightened: require a recognizable AI role noun to avoid false positives in docs/comments
  /you\s+are\s+now\s+(?:a\s+)?(?:different\s+)?(?:AI|assistant|bot|system|language\s+model)/i,
  /forget\s+(all\s+)?previous\s+/i,
  /override\s+(your\s+)?instructions?/i,
  /act\s+as\s+if\s+you\s+have\s+no\s+/i,
]

// Maximum bytes to scan in any single string field (protects against latency on large Write payloads)
const MAX_SCAN_BYTES = 10_000

/**
 * Extracts scannable string snippets from a PermissionRequest input.
 * Limits large content fields (Write content, Edit old/new strings) to MAX_SCAN_BYTES.
 * @param {string} tool
 * @param {object} input
 * @returns {string[]}
 */
function extractTexts(tool, input) {
  const texts = []
  if (tool === 'Bash') {
    if (typeof input.command === 'string') texts.push(input.command)
    return texts
  }
  // file_path / pattern / path / command (short fields) — always scan fully
  for (const key of ['file_path', 'pattern', 'path', 'command']) {
    if (typeof input[key] === 'string') texts.push(input[key])
  }
  // Large content fields — limit to first MAX_SCAN_BYTES characters
  for (const key of ['content', 'old_string', 'new_string']) {
    if (typeof input[key] === 'string') texts.push(input[key].slice(0, MAX_SCAN_BYTES))
  }
  // MultiEdit: unpack nested edits array
  if (Array.isArray(input.edits)) {
    for (const edit of input.edits) {
      if (typeof edit.old_string === 'string') texts.push(edit.old_string.slice(0, MAX_SCAN_BYTES))
      if (typeof edit.new_string === 'string') texts.push(edit.new_string.slice(0, MAX_SCAN_BYTES))
    }
  }
  return texts
}

/**
 * Checks a PermissionRequest input for prompt injection patterns.
 * @param {object} input
 * @param {string} [tool]
 * @returns {{ injected: boolean, reason: string | null }}
 */
export function hasInjection(input, tool = '') {
  const texts = extractTexts(tool, input)
  for (const text of texts) {
    for (const pattern of INJECTION_PATTERNS) {
      if (pattern.test(text)) {
        return { injected: true, reason: `Injection pattern detected: ${pattern}` }
      }
    }
  }
  return { injected: false, reason: null }
}
