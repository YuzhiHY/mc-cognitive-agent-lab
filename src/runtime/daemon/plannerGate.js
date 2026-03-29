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
    // Allow planning if combat mode is active but no actual threat exists nearby.
    // This prevents 5-cycle idle stalls after a flee when the danger has passed.
    const threat = snapshot?.threat_level || 'none'
    const entities = Array.isArray(snapshot?.nearby?.entities) ? snapshot.nearby.entities : []
    const hostileNearby = entities.some((e) => {
      const name = String(e.name || e.kind || '').toLowerCase()
      return e.distance <= 6 && (
        name === 'zombie' || name === 'skeleton' || name === 'creeper' ||
        name === 'spider' || name === 'enderman' || name === 'drowned' ||
        name === 'husk' || name === 'stray' || name === 'cave_spider' ||
        name === 'witch' || name === 'slime' || name === 'phantom'
      )
    })
    if (threat !== 'none' || hostileNearby) {
      return {
        allowed: false,
        reason: 'combat_mode_hold',
        combatHold: true,
        state: taskSm.getState().state,
        executionLock: taskSm.getState().executionLock,
        threat,
      }
    }
    // Threat gone — release combat hold early, allow planning
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
