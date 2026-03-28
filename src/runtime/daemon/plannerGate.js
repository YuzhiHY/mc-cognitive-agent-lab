/**
 * Planner Gate (Phase 9.5).
 *
 * Checks whether the planner (centralReasoning) is allowed to run this cycle.
 * Pure evaluator — no side effects.
 */

/**
 * Returns { allowed, reason, combatHold }
 */
function evaluatePlannerGate({ taskSm, reflexLayer, snapshot, cycleCount }) {
  if (!taskSm.canPlan()) {
    return {
      allowed: false,
      reason: 'task_state_machine_canPlan_false',
      combatHold: false,
      state: taskSm.getState().state,
      executionLock: taskSm.getState().executionLock,
    }
  }
  if (typeof reflexLayer?.isCombatMode === 'function' && reflexLayer.isCombatMode()) {
    return {
      allowed: false,
      reason: 'combat_mode_hold',
      combatHold: true,
      state: taskSm.getState().state,
      executionLock: taskSm.getState().executionLock,
      threat: snapshot?.threat_level || null,
    }
  }
  return {
    allowed: true,
    reason: 'task_state_machine_canPlan_true',
    combatHold: false,
    state: taskSm.getState().state,
    executionLock: taskSm.getState().executionLock,
  }
}

module.exports = { evaluatePlannerGate }
