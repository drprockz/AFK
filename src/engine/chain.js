// src/engine/chain.js
import { isSensitive } from './sensitive.js'
import { hasInjection } from './injection.js'
import { classify } from './classifier.js'
import { matchRule } from './rules.js'
import { predict } from './predictor.js'
import { detectAnomaly } from './anomaly.js'
import { isAfk, appendDigest } from '../afk/state.js'
import { logDecision } from '../store/history.js'
import { existsSync } from 'node:fs'
import { checkAndAutoAfk } from '../afk/detector.js'
import { snapshot } from '../safety/snapshot.js'
import { enqueueDeferred } from '../store/queue.js'
import { notify } from '../notify/notify.js'
import { loadConfig } from '../notify/config.js'
import { randomUUID } from 'node:crypto'

/**
 * Extracts command and path from a PermissionRequest input.
 * @param {string} tool
 * @param {object} input
 * @returns {{ command: string|null, path: string|null }}
 */
function extractFields(tool, input) {
  return {
    command: tool === 'Bash' ? (input.command ?? null) : null,
    path: input.file_path ?? input.path ?? null
  }
}

/**
 * Full 7-step decision chain. Must complete before deadline.
 * Step 7 is simplified in Phase 1+2: notifications/dashboard are Phase 5/6.
 * @param {object} request  — { tool, input, session_id, cwd }
 * @param {number} deadline — Unix ms timestamp after which chain must return
 * @returns {Promise<{ behavior: 'allow'|'deny'|'ask', decision: string, source: string, reason: string }>}
 */
export async function chain(request, deadline) {
  // Deadline guard — if already expired, fail closed immediately
  if (Date.now() >= deadline) {
    return { behavior: 'ask', decision: 'ask', source: 'chain', reason: 'deadline expired before chain start' }
  }

  const { tool, input, session_id, cwd } = request
  const { command, path } = extractFields(tool, input)
  checkAndAutoAfk()           // may flip state to AFK on before we read it
  const afkOn = isAfk()       // reads updated state

  function log(decision, source, opts = {}) {
    try {
      logDecision({ session_id, tool, input, command, path, decision, source, project_cwd: cwd, ...opts })
    } catch { /* non-fatal — never block on logging */ }
  }

  // ── Step 1: Sensitive path guard ─────────────────────────────────────────
  // source='chain': hard safety gate, not a user/rule/prediction decision.
  // Sensitive requests always interrupt — even in AFK mode.
  const sensitive = isSensitive(tool, input)
  if (sensitive.sensitive) {
    log('ask', 'chain', { reason: `Sensitive path: ${sensitive.matched}` })
    // Phase 3: in AFK mode, also fire-and-forget an urgent notification here
    return { behavior: 'ask', decision: 'ask', source: 'chain', reason: `Sensitive path detected: ${sensitive.matched}` }
  }

  // ── Step 2: Prompt injection ──────────────────────────────────────────────
  // source='chain': hard safety gate, immediate deny.
  const injection = hasInjection(input, tool)
  if (injection.injected) {
    log('deny', 'chain', { reason: injection.reason })
    return { behavior: 'deny', decision: 'deny', source: 'chain', reason: injection.reason }
  }

  // ── Step 3: Destructive classifier ───────────────────────────────────────
  // For Write/Edit, check if file exists to flag overwrite as destructive
  const inputWithExistence = (tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit') && path
    ? { ...input, _existsOnDisk: existsSync(path) }
    : input
  const destructive = classify(tool, inputWithExistence)
  if (destructive.destructive) {
    // Before deferring/interrupting: check if a static deny rule applies.
    // A deny rule is more specific/intentional than the generic "ask" that the
    // destructive classifier would produce — honour it for a cleaner signal.
    let denyRule = null
    try { denyRule = matchRule({ tool, input, cwd }) } catch { /* non-fatal — treat as no rule */ }
    if (denyRule && denyRule.action === 'deny') {
      log('deny', 'rule', { rule_id: denyRule.id, reason: `Rule (destructive override): ${denyRule.label ?? denyRule.pattern}` })
      return { behavior: 'deny', decision: 'deny', source: 'rule', reason: `Matched deny rule: ${denyRule.label ?? denyRule.pattern}` }
    }

    if (afkOn) {
      // AFK-ON: snapshot → log → enqueue → appendDigest → ask
      // logDecision called DIRECTLY (not via log()) to capture lastInsertRowid for FK
      // enqueueDeferred receives original `input`, NOT `inputWithExistence` (no internal annotations)
      const remaining = deadline - Date.now()
      let snapshotResult = { snapshotted: false, commit: null }
      if (remaining > 3000) {
        snapshotResult = await snapshot(cwd, destructive.reason)
      }
      const snapshotNote = snapshotResult.snapshotted
        ? `Snapshot: ${snapshotResult.commit}`
        : 'Snapshot: skipped'
      let decisionsId
      try {
        decisionsId = logDecision({
          session_id, tool, input, command, path,
          decision: 'defer',
          source: 'auto_defer',
          project_cwd: cwd,
          reason: `Destructive: ${destructive.reason} (${destructive.severity}). ${snapshotNote}`
        })
      } catch { /* non-fatal */ }
      if (decisionsId != null) {
        try { enqueueDeferred({ decisionsId, sessionId: session_id, tool, input, command, path }) } catch { /* non-fatal */ }
      }
      try { appendDigest({ tool, command, path, decision: 'defer', ts: Date.now() }) } catch { /* non-fatal */ }
      return { behavior: 'ask', decision: 'defer', source: 'auto_defer', reason: `Destructive action deferred: ${destructive.reason}` }
    } else {
      // AFK-OFF: log as ask + chain source (hard safety gate, not a user/rule/prediction decision)
      log('ask', 'chain', { reason: `Destructive: ${destructive.reason} (${destructive.severity})` })
    }
    return { behavior: 'ask', decision: 'ask', source: 'chain', reason: `Destructive action detected: ${destructive.reason}` }
  }

  // ── Step 4: Static rules ──────────────────────────────────────────────────
  let rule = null
  try { rule = matchRule({ tool, input, cwd }) } catch { /* non-fatal — treat as no rule */ }
  if (rule) {
    const behavior = rule.action === 'allow' ? 'allow' : 'deny'
    log(behavior, 'rule', { rule_id: rule.id, reason: `Rule: ${rule.label ?? rule.pattern}` })
    return { behavior, decision: behavior, source: 'rule', reason: `Matched rule: ${rule.label ?? rule.pattern}` }
  }

  // ── Step 5: Anomaly detector ──────────────────────────────────────────────
  const anomaly = detectAnomaly({ tool, input, cwd })
  if (anomaly.anomalous) {
    if (afkOn) {
      // AFK-ON: log as defer, enqueue, appendDigest — no snapshot (not destructive)
      // logDecision called DIRECTLY (not via log()) to capture lastInsertRowid for FK
      let decisionsId
      try {
        decisionsId = logDecision({
          session_id, tool, input, command, path,
          decision: 'defer',
          source: 'auto_defer',
          project_cwd: cwd,
          reason: `Anomaly (score=${anomaly.score.toFixed(2)}): ${anomaly.reason}`
        })
      } catch { /* non-fatal */ }
      if (decisionsId != null) {
        try { enqueueDeferred({ decisionsId, sessionId: session_id, tool, input, command, path }) } catch { /* non-fatal */ }
      }
      try { appendDigest({ tool, command, path, decision: 'defer', ts: Date.now() }) } catch { /* non-fatal */ }
      return { behavior: 'ask', decision: 'defer', source: 'auto_defer', reason: `Anomalous request deferred: ${anomaly.reason}` }
    } else {
      // AFK-OFF: interrupt user with explanation
      log('ask', 'chain', { reason: `Anomaly (score=${anomaly.score.toFixed(2)}): ${anomaly.reason}` })
      return { behavior: 'ask', decision: 'ask', source: 'chain', reason: `Unusual request detected: ${anomaly.reason}` }
    }
  }

  // ── Step 6: Behavior predictor ────────────────────────────────────────────
  const prediction = predict({ tool, input, cwd })
  if (prediction.confidence > 0.85) {
    const behavior = prediction.predicted
    log(behavior, 'prediction', { confidence: prediction.confidence, reason: prediction.explanation })
    return { behavior, decision: behavior, source: 'prediction', reason: prediction.explanation }
  }
  if (prediction.confidence < 0.15) {
    log('deny', 'prediction', { confidence: prediction.confidence, reason: prediction.explanation })
    return { behavior: 'deny', decision: 'deny', source: 'prediction', reason: prediction.explanation }
  }

  // ── Step 7: Smart AFK fallback ────────────────────────────────────────────
  // AFK-ON: send notification, wait for user response.
  // "allow", "skip", or "timeout" all auto-approve (notifications are additive, never blocking).
  // Only a "deny" response interrupts. AFK-OFF falls through to ask.
  if (afkOn) {
    const requestId = randomUUID()
    const notifyResult = await notify(loadConfig(), { tool, command, path, requestId }, deadline)
    if (notifyResult === 'deny') {
      log('deny', 'notification', { reason: 'User denied via notification' })
      try { appendDigest({ tool, command, path, decision: 'deny', ts: Date.now() }) } catch { /* non-fatal */ }
      return { behavior: 'deny', decision: 'deny', source: 'notification', reason: 'Denied via push notification' }
    }
    // "allow", "skip", or "timeout" → fall through to auto-approve
    log('allow', 'auto_afk', { reason: `AFK mode: auto-approved (notify=${notifyResult})` })
    try { appendDigest({ tool, command, path, decision: 'allow', ts: Date.now() }) } catch { /* non-fatal */ }
    return { behavior: 'allow', decision: 'allow', source: 'auto_afk', reason: 'AFK mode: auto-approved' }
  }

  // AFK-OFF, predictor uncertain (0.15–0.85): auto-allow.
  // The action passed every safety check (not sensitive, not injected, not destructive,
  // no deny rule, not anomalous). Interrupting the user here would add noise without
  // safety value. Allow it and let history build naturally.
  log('allow', 'auto_allow', { confidence: prediction.confidence, reason: 'Passed all safety checks; auto-approved' })
  return { behavior: 'allow', decision: 'allow', source: 'auto_allow', reason: 'Passed all safety checks' }
}
