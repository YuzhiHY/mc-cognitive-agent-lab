const STATES = Object.freeze([
  'idle',
  'assessing',
  'planning',
  'executing',
  'interrupted',
  'recovering',
  'completed',
  'failed',
  'cooling_down',
])

const ALLOWED = Object.freeze({
  idle: new Set(['assessing', 'cooling_down']),
  assessing: new Set(['planning', 'interrupted', 'failed']),
  planning: new Set(['executing', 'failed', 'interrupted']),
  executing: new Set(['completed', 'failed', 'interrupted', 'recovering']),
  interrupted: new Set(['recovering', 'assessing', 'cooling_down']),
  recovering: new Set(['assessing', 'failed', 'completed']),
  completed: new Set(['cooling_down', 'assessing', 'idle']),
  failed: new Set(['recovering', 'assessing', 'cooling_down']),
  cooling_down: new Set(['assessing', 'idle']),
})

function cloneMeta(meta) {
  return meta && typeof meta === 'object' ? { ...meta } : {}
}

function createTaskStateMachine({
  onTransition = null,
  initialState = 'idle',
} = {}) {
  const state = {
    current: STATES.includes(initialState) ? initialState : 'idle',
    executionLock: false,
    lastReason: null,
    updatedAt: Date.now(),
    revision: 0,
    meta: {},
  }

  function snapshot() {
    return Object.freeze({
      state: state.current,
      executionLock: state.executionLock,
      lastReason: state.lastReason,
      updatedAt: state.updatedAt,
      revision: state.revision,
      meta: cloneMeta(state.meta),
    })
  }

  function canTransition(from, to) {
    if (!STATES.includes(to)) return false
    const allowed = ALLOWED[from]
    if (!allowed) return false
    return allowed.has(to)
  }

  function transition(to, { reason = null, meta = null, force = false } = {}) {
    const from = state.current
    if (!STATES.includes(to)) {
      return {
        ok: false,
        from,
        to,
        reason: 'unknown_state',
      }
    }
    if (!force && !canTransition(from, to)) {
      return {
        ok: false,
        from,
        to,
        reason: 'invalid_transition',
      }
    }
    state.current = to
    state.lastReason = reason || null
    state.updatedAt = Date.now()
    state.revision += 1
    state.meta = cloneMeta(meta)
    if (to === 'executing') state.executionLock = true
    if (['completed', 'failed', 'interrupted', 'recovering', 'idle', 'cooling_down'].includes(to)) {
      state.executionLock = false
    }
    const evt = {
      ok: true,
      from,
      to,
      reason: state.lastReason,
      executionLock: state.executionLock,
      revision: state.revision,
      updatedAt: state.updatedAt,
      meta: cloneMeta(state.meta),
    }
    if (typeof onTransition === 'function') {
      try { onTransition(evt) } catch { /* non-fatal */ }
    }
    return evt
  }

  function setExecutionLock(value, reason = null) {
    state.executionLock = !!value
    state.lastReason = reason || state.lastReason
    state.updatedAt = Date.now()
    state.revision += 1
  }

  function isExecutionLocked() {
    return state.executionLock
  }

  function canPlan() {
    if (state.executionLock) return false
    return ['idle', 'assessing', 'planning', 'interrupted', 'recovering', 'completed', 'failed', 'cooling_down'].includes(state.current)
  }

  function evaluateInterruptPolicy({
    decision = null,
    currentSkillMeta = null,
    currentExecutionMeta = null,
    currentState = null,
    runtimeMode = 'normal',
  } = {}) {
    const effectiveState = currentState || state.current
    if (!state.executionLock) {
      return { accept: false, policyReason: 'execution_not_locked' }
    }
    if (!decision || decision.shouldInterrupt !== true) {
      return { accept: false, policyReason: 'no_interrupt_decision' }
    }

    const priority = String(decision.priority || 'low')
    const source = String(decision.source || 'system')
    const fallbackMode = String(decision.fallbackMode || '')
    const skillInterruptible = currentSkillMeta?.canInterrupt !== false
    const executionInterruptible = currentExecutionMeta?.interruptible !== false
    const isInterruptible = skillInterruptible && executionInterruptible

    if (effectiveState === 'recovering' && priority !== 'fatal_immediate') {
      return { accept: false, policyReason: 'recovering_mode_defers_non_fatal' }
    }
    if (runtimeMode === 'reflex_safe' && priority === 'low') {
      return { accept: false, policyReason: 'reflex_safe_defers_low' }
    }
    if (priority === 'fatal_immediate') {
      return { accept: true, policyReason: 'fatal_immediate_always_interrupts' }
    }
    if (priority === 'high') {
      if (!isInterruptible) {
        return { accept: false, policyReason: 'high_blocked_uninterruptible_execution' }
      }
      return { accept: true, policyReason: 'high_interrupt_allowed' }
    }
    if (priority === 'medium') {
      if (!isInterruptible) return { accept: false, policyReason: 'medium_blocked_uninterruptible_execution' }
      if (source === 'world_change' || source === 'damage' || fallbackMode === 'reflex_safe') {
        return { accept: true, policyReason: 'medium_allowed_by_source_or_fallback' }
      }
      return { accept: false, policyReason: 'medium_deferred_by_policy' }
    }
    if (priority === 'low') {
      if (source === 'world_change' && isInterruptible && runtimeMode !== 'normal') {
        return { accept: true, policyReason: 'low_world_change_allowed_non_normal_mode' }
      }
      return { accept: false, policyReason: 'low_deferred_default' }
    }
    return { accept: false, policyReason: 'unknown_priority_deferred' }
  }

  function shouldInterruptExecution(input = null) {
    if (input && typeof input === 'object' && Object.prototype.hasOwnProperty.call(input, 'decision')) {
      return evaluateInterruptPolicy(input).accept
    }
    return evaluateInterruptPolicy({ decision: input }).accept
  }

  return Object.freeze({
    STATES,
    getState: snapshot,
    transition,
    setExecutionLock,
    isExecutionLocked,
    canPlan,
    evaluateInterruptPolicy,
    shouldInterruptExecution,
  })
}

module.exports = { createTaskStateMachine, STATES }

