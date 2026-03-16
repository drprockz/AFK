const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions?/i,
  /disregard\s+(all\s+)?(previous\s+)?instructions?/i,
  /new\s+system\s+prompt/i,
  /you\s+are\s+now\s+a\s+(different\s+)?/i,
  /forget\s+(all\s+)?previous\s+/i,
  /override\s+(your\s+)?instructions?/i,
  /act\s+as\s+if\s+you\s+have\s+no\s+/i,
]

/**
 * Checks all string fields of an input object for prompt injection patterns.
 * @param {object} input
 * @returns {{ injected: boolean, reason: string | null }}
 */
export function hasInjection(input) {
  const texts = Object.values(input).filter(v => typeof v === 'string')
  for (const text of texts) {
    for (const pattern of INJECTION_PATTERNS) {
      if (pattern.test(text)) {
        return { injected: true, reason: `Injection pattern detected: ${pattern}` }
      }
    }
  }
  return { injected: false, reason: null }
}
