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

  function shouldInterruptExecution(decision = null) {
    if (!state.executionLock) return false
    if (!decision || decision.shouldInterrupt !== true) return false
    const p = String(decision.priority || 'low')
    if (p === 'fatal_immediate' || p === 'high') return true
    if (p === 'medium') return true
    if (p === 'low') {
      const src = String(decision.source || '')
      if (src === 'world_change' || src === 'system') return true
      return false
    }
    return false
  }

  return Object.freeze({
    STATES,
    getState: snapshot,
    transition,
    setExecutionLock,
    isExecutionLocked,
    canPlan,
    shouldInterruptExecution,
  })
}

module.exports = { createTaskStateMachine, STATES }

