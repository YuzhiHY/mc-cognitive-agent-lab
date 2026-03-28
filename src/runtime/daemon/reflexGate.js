/**
 * Reflex Gate (Phase 9.5).
 *
 * Evaluates reflex arbitration and policy. Pure evaluator — does NOT
 * execute the takeover or produce side effects.
 */

/**
 * Evaluate whether a reflex takeover should occur.
 *
 * Returns null if no reflex fires, or { interrupt, reflexAction, policy }
 */
function evaluateReflexGate({ reflexLayer, snapshot, ctx, taskSm, shared }) {
  if (!reflexLayer) return null

  let interrupt, reflexAction
  if (typeof reflexLayer.arbitrate === 'function') {
    const arbitrated = reflexLayer.arbitrate(snapshot, ctx)
    interrupt = arbitrated.decision
    reflexAction = arbitrated.matchedRule
  } else {
    reflexAction = reflexLayer.check(snapshot, ctx)
    interrupt = reflexAction !== null
      ? {
        shouldInterrupt: true,
        priority: 'high',
        interruptReason: 'legacy_reflex',
        suggestedSkill: null,
        fallbackMode: 'reflex_safe',
        metadata: {},
      }
      : { shouldInterrupt: false }
  }

  if (!interrupt?.shouldInterrupt || !reflexAction) return null

  const policy = taskSm.evaluateInterruptPolicy({
    decision: interrupt,
    currentSkillMeta: shared.currentSkillMeta,
    currentExecutionMeta: shared.currentExecutionMeta,
    currentState: taskSm.getState().state,
    runtimeMode: taskSm.getState().state === 'recovering' ? 'recovering' : 'normal',
  })

  const holdExecution = taskSm.isExecutionLocked() && !policy.accept

  return { interrupt, reflexAction, policy, holdExecution }
}

module.exports = { evaluateReflexGate }
