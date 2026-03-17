// src/engine/chain.js
import { isSensitive } from './sensitive.js'
import { hasInjection } from './injection.js'
import { classify } from './classifier.js'
import { matchRule } from './rules.js'
import { predict } from './predictor.js'
import { detectAnomaly } from './anomaly.js'
import { isAfk, getSessionId, appendDigest } from '../afk/state.js'
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
 * @returns {Promise<{ behavior: 'allow'|'deny'|'ask', reason: string }>}
 */
export async function chain(request, deadline) {
  // Deadline guard — if already expired, fail closed immediately
  if (Date.now() >= deadline) {
    return { behavior: 'ask', reason: 'deadline expired before chain start' }
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
    return { behavior: 'ask', reason: `Sensitive path detected: ${sensitive.matched}` }
  }

  // ── Step 2: Prompt injection ──────────────────────────────────────────────
  // source='chain': hard safety gate, immediate deny.
  const injection = hasInjection(input)
  if (injection.injected) {
    log('deny', 'chain', { reason: injection.reason })
    return { behavior: 'deny', reason: injection.reason }
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
    const denyRule = matchRule({ tool, input, cwd })
    if (denyRule && denyRule.action === 'deny') {
      log('deny', 'rule', { rule_id: denyRule.id, reason: `Rule (destructive override): ${denyRule.label ?? denyRule.pattern}` })
      return { behavior: 'deny', reason: `Matched deny rule: ${denyRule.label ?? denyRule.pattern}` }
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
      appendDigest({ tool, command, path, decision: 'defer', ts: Date.now() })
      return { behavior: 'ask', reason: `Destructive action deferred: ${destructive.reason}` }
    } else {
      // AFK-OFF: log as ask + chain source (hard safety gate, not a user/rule/prediction decision)
      log('ask', 'chain', { reason: `Destructive: ${destructive.reason} (${destructive.severity})` })
    }
    return { behavior: 'ask', reason: `Destructive action detected: ${destructive.reason}` }
  }

  // ── Step 4: Static rules ──────────────────────────────────────────────────
  const rule = matchRule({ tool, input, cwd })
  if (rule) {
    const behavior = rule.action === 'allow' ? 'allow' : 'deny'
    log(behavior, 'rule', { rule_id: rule.id, reason: `Rule: ${rule.label ?? rule.pattern}` })
    return { behavior, reason: `Matched rule: ${rule.label ?? rule.pattern}` }
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
      appendDigest({ tool, command, path, decision: 'defer', ts: Date.now() })
      return { behavior: 'ask', reason: `Anomalous request deferred: ${anomaly.reason}` }
    } else {
      // AFK-OFF: interrupt user with explanation
      log('ask', 'chain', { reason: `Anomaly (score=${anomaly.score.toFixed(2)}): ${anomaly.reason}` })
      return { behavior: 'ask', reason: `Unusual request detected: ${anomaly.reason}` }
    }
  }

  // ── Step 6: Behavior predictor ────────────────────────────────────────────
  const prediction = predict({ tool, input, cwd })
  if (prediction.confidence > 0.85) {
    const behavior = prediction.predicted
    log(behavior, 'prediction', { confidence: prediction.confidence, reason: prediction.explanation })
    return { behavior, reason: prediction.explanation }
  }
  if (prediction.confidence < 0.15) {
    log('deny', 'prediction', { confidence: prediction.confidence, reason: prediction.explanation })
    return { behavior: 'deny', reason: prediction.explanation }
  }

  // ── Step 7: Smart AFK fallback ────────────────────────────────────────────
  // Phase 1+2 scope: AFK ON → auto-approve; else → ask.
  // Phase 5/6 will add notification and dashboard queue branches here.
  // IMPORTANT for Phase 5 wiring: before any await of a notification response,
  // compute: const remaining = deadline - Date.now()
  // if (remaining <= 2000) return { behavior: 'ask', reason: 'deadline' }
  // const waitMs = Math.min(config.notifications.timeout * 1000, remaining - 2000)
  if (afkOn) {
    const requestId = randomUUID()
    const notifyResult = await notify(loadConfig(), { tool, command, path, requestId }, deadline)
    if (notifyResult === 'deny') {
      log('deny', 'notification', { reason: 'User denied via notification' })
      appendDigest({ tool, command, path, decision: 'deny', ts: Date.now() })
      return { behavior: 'deny', reason: 'Denied via push notification' }
    }
    // "allow", "skip", or "timeout" → fall through to auto-approve
    log('allow', 'auto_afk', { reason: `AFK mode: auto-approved (notify=${notifyResult})` })
    appendDigest({ tool, command, path, decision: 'allow', ts: Date.now() })
    return { behavior: 'allow', reason: 'AFK mode: auto-approved' }
  }

  // source='prediction': this decision came from the predictor's uncertainty band (0.15–0.85)
  log('ask', 'prediction', { confidence: prediction.confidence, reason: 'Low confidence, user prompt required' })
  return { behavior: 'ask', reason: 'Insufficient confidence — user input required' }
}
