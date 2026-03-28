/**
 * Task state transition helper (Phase 9.5).
 *
 * Bridges taskStateMachine (the authority) with logging and trace recording.
 * Used by interruptExecutor, chainOrchestrator, and daemon main loop.
 */

function nowIso() {
  return new Date().toISOString()
}

function createTaskStateHelper({ taskSm, logger, shared }) {
  async function setTaskState(state, extra = {}) {
    if (!shared.activeTask) {
      shared.activeTask = {
        id: `daemon-task-${Date.now()}`,
        createdAt: nowIso(),
      }
    }
    const prev = taskSm.getState()
    if (prev.state === state && extra.force !== true) {
      await logger.log({
        type: 'daemon_state_transition_skip',
        taskId: shared.activeTask.id,
        state,
        cycle: extra.cycle ?? shared.cycleCount,
        reason: 'already_in_state',
      })
      return
    }
    const tx = taskSm.transition(state, {
      reason: extra.reason || null,
      meta: extra || null,
      force: extra.force === true,
    })
    const cur = taskSm.getState()
    if (!tx?.ok) {
      await logger.log({
        type: 'daemon_state_transition_rejected',
        taskId: shared.activeTask.id,
        from: prev.state,
        to: state,
        reason: tx?.reason || 'invalid_transition',
        cycle: extra.cycle ?? shared.cycleCount,
      })
      return
    }
    shared.activeTask = {
      ...shared.activeTask,
      updatedAt: nowIso(),
      ...extra,
    }
    await logger.log({
      type: 'daemon_task_state',
      taskId: shared.activeTask.id,
      state: cur.state,
      reason: extra.reason || null,
      error: extra.error || null,
    })
    await logger.log({
      type: 'daemon_state_transition',
      taskId: shared.activeTask.id,
      from: prev.state,
      to: cur.state,
      executionLock: cur.executionLock,
      reason: extra.reason || null,
      cycle: extra.cycle ?? shared.cycleCount,
      goal: extra.goal || null,
      skillName: extra.skillName || null,
      chainSignature: extra.chainSignature || null,
    })
    shared.stateTransitionTrace.push({
      from: prev.state,
      to: cur.state,
      reason: extra.reason || null,
      executionLock: cur.executionLock,
      cycle: extra.cycle ?? shared.cycleCount,
      goal: extra.goal || null,
      skillName: extra.skillName || null,
      chainSignature: extra.chainSignature || null,
    })
    if (shared.stateTransitionTrace.length > 80) shared.stateTransitionTrace.shift()
  }

  return { setTaskState }
}

module.exports = { createTaskStateHelper }
