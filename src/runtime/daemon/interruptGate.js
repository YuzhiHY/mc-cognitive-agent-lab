/**
 * Interrupt Gate (Phase 9.5).
 *
 * Builds interrupt candidates from multiple sources, ranks by priority,
 * and evaluates policy. Pure evaluator — does NOT pop queue or log.
 */

const {
  noInterrupt,
  systemInterrupt,
} = require('../contracts/interruptDecision')

const PRIORITY_RANK = { fatal_immediate: 4, high: 3, medium: 2, low: 1 }

/**
 * Build interrupt candidates from all sources.
 */
function buildInterruptCandidates({ snapshot, cycleCount, queuedDecision, worldChangeDecision }) {
  const immediateDangerDecision = (snapshot?.close_threat === true
    || (snapshot?.status?.recentDamageMs != null && snapshot.status.recentDamageMs < 2500))
    ? systemInterrupt({
      source: 'system',
      priority: 'high',
      interruptReason: 'high_priority_danger_window',
      metadata: {
        cycle: cycleCount,
        closeThreat: snapshot?.close_threat === true,
        recentDamageMs: snapshot?.status?.recentDamageMs ?? null,
      },
    })
    : noInterrupt({ source: 'system', reason: 'no_high_priority_window', metadata: { cycle: cycleCount } })

  return [queuedDecision, immediateDangerDecision, worldChangeDecision]
    .filter((d) => d && d.shouldInterrupt)
    .sort((a, b) => (PRIORITY_RANK[b.priority] || 0) - (PRIORITY_RANK[a.priority] || 0))
}

/**
 * Evaluate the interrupt gate: pick top candidate, run policy check.
 *
 * Returns { topDecision, policy, holdExecution }
 */
function evaluateInterruptGate({
  snapshot,
  cycleCount,
  queuedDecision,
  worldChangeDecision,
  taskSm,
  shared,
}) {
  const candidates = buildInterruptCandidates({
    snapshot,
    cycleCount,
    queuedDecision,
    worldChangeDecision,
  })

  const topDecision = candidates[0] || noInterrupt({
    source: 'system',
    reason: 'no_interrupt_candidate',
    metadata: { cycle: cycleCount },
  })

  const policy = taskSm.evaluateInterruptPolicy({
    decision: topDecision,
    currentSkillMeta: shared.currentSkillMeta,
    currentExecutionMeta: shared.currentExecutionMeta,
    currentState: taskSm.getState().state,
    runtimeMode: taskSm.getState().state === 'recovering' ? 'recovering' : 'normal',
  })

  const holdExecution = taskSm.isExecutionLocked() && !policy.accept

  return { topDecision, policy, holdExecution }
}

module.exports = { buildInterruptCandidates, evaluateInterruptGate }
