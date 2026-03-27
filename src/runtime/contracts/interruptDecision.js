const PRIORITIES = Object.freeze(['fatal_immediate', 'high', 'medium', 'low'])
const SOURCES = Object.freeze(['reflex', 'damage', 'world_change', 'planner', 'system'])

function normalizePriority(priority) {
  const p = String(priority || 'low')
  return PRIORITIES.includes(p) ? p : 'low'
}

function normalizeSource(source) {
  const s = String(source || 'system')
  return SOURCES.includes(s) ? s : 'system'
}

function baseDecision({
  shouldInterrupt = false,
  priority = 'low',
  interruptReason = 'none',
  source = 'system',
  suggestedSkill = null,
  fallbackMode = null,
  metadata = null,
} = {}) {
  return Object.freeze({
    shouldInterrupt: !!shouldInterrupt,
    priority: normalizePriority(priority),
    interruptReason: String(interruptReason || 'none'),
    source: normalizeSource(source),
    suggestedSkill: suggestedSkill ? String(suggestedSkill) : null,
    fallbackMode: fallbackMode ? String(fallbackMode) : null,
    metadata: metadata && typeof metadata === 'object' ? { ...metadata } : null,
  })
}

function noInterrupt({ source = 'system', reason = 'no_interrupt', metadata = null } = {}) {
  return baseDecision({
    shouldInterrupt: false,
    priority: 'low',
    interruptReason: reason,
    source,
    metadata,
  })
}

function interruptDecision({
  priority = 'medium',
  interruptReason = 'interrupt',
  source = 'system',
  suggestedSkill = null,
  fallbackMode = null,
  metadata = null,
} = {}) {
  return baseDecision({
    shouldInterrupt: true,
    priority,
    interruptReason,
    source,
    suggestedSkill,
    fallbackMode,
    metadata,
  })
}

function reflexInterrupt({
  priority = 'high',
  interruptReason = 'reflex_interrupt',
  suggestedSkill = null,
  fallbackMode = 'reflex_safe',
  metadata = null,
} = {}) {
  return interruptDecision({
    priority,
    interruptReason,
    source: 'reflex',
    suggestedSkill,
    fallbackMode,
    metadata,
  })
}

function systemInterrupt({
  priority = 'high',
  interruptReason = 'system_interrupt',
  source = 'system',
  suggestedSkill = null,
  fallbackMode = null,
  metadata = null,
} = {}) {
  return interruptDecision({
    priority,
    interruptReason,
    source,
    suggestedSkill,
    fallbackMode,
    metadata,
  })
}

module.exports = {
  PRIORITIES,
  SOURCES,
  baseDecision,
  noInterrupt,
  interruptDecision,
  reflexInterrupt,
  systemInterrupt,
}

