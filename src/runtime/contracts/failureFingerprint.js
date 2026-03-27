/**
 * Failure Fingerprint Contract
 *
 * Normalized failure records that allow the system to learn from
 * repeated failures and avoid repeating the same approach.
 */

const FAILURE_CLASSES = Object.freeze([
  'path_blocked',
  'unreachable_target',
  'no_required_item',
  'hostile_interrupt',
  'unsafe_terrain',
  'stuck_collision',
  'placement_failed',
  'dig_failed',
  'timeout',
  'invalid_generated_skill',
  'craft_missing_materials',
  'unknown',
])

/**
 * Create a normalized failure fingerprint.
 */
function createFingerprint({
  actionType,
  skillName = null,
  failureClass = 'unknown',
  reason = '',
  location = null,
  targetType = null,
  contextualTags = [],
  retryable = true,
} = {}) {
  return Object.freeze({
    timestamp: Date.now(),
    actionType: String(actionType || 'unknown'),
    skillName: skillName || null,
    failureClass: FAILURE_CLASSES.includes(failureClass) ? failureClass : 'unknown',
    reason: String(reason || ''),
    location: location || null,
    targetType: targetType || null,
    contextualTags: Array.isArray(contextualTags) ? contextualTags : [],
    retryable: !!retryable,
  })
}

/**
 * Classify a failure from an execution result and context.
 */
function classifyFailure(executionResult, context = {}) {
  const status = executionResult?.status || ''
  const reason = executionResult?.reason || executionResult?.errorMessage || ''
  const actionType = executionResult?.actionType || context.actionType || 'unknown'
  const lower = reason.toLowerCase()

  let failureClass = 'unknown'

  if (status === 'timeout') {
    failureClass = 'timeout'
  } else if (status === 'interrupted') {
    failureClass = lower.includes('hostile') || lower.includes('damage')
      ? 'hostile_interrupt'
      : 'hostile_interrupt'
  } else if (lower.includes('path') || lower.includes('navigate') || lower.includes('goal')) {
    failureClass = 'path_blocked'
  } else if (lower.includes('unreachable') || lower.includes('not found') || lower.includes('no block')) {
    failureClass = 'unreachable_target'
  } else if (lower.includes('stuck') || lower.includes('collision') || lower.includes('impasse')) {
    failureClass = 'stuck_collision'
  } else if (lower.includes('place') || lower.includes('placement')) {
    failureClass = 'placement_failed'
  } else if (lower.includes('dig') || lower.includes('mine') || lower.includes('block not')) {
    failureClass = 'dig_failed'
  } else if (lower.includes('craft') || lower.includes('material') || lower.includes('recipe')) {
    failureClass = 'craft_missing_materials'
  } else if (lower.includes('item') || lower.includes('equip') || lower.includes('missing')) {
    failureClass = 'no_required_item'
  } else if (lower.includes('lava') || lower.includes('water') || lower.includes('fall') || lower.includes('terrain')) {
    failureClass = 'unsafe_terrain'
  } else if (lower.includes('sandbox') || lower.includes('generated') || lower.includes('invalid_skill')) {
    failureClass = 'invalid_generated_skill'
  }

  return createFingerprint({
    actionType,
    skillName: executionResult?.skillName || context.skillName || null,
    failureClass,
    reason,
    location: context.location || null,
    targetType: context.targetType || null,
    contextualTags: context.tags || [],
    retryable: status !== 'invalid' && failureClass !== 'invalid_generated_skill',
  })
}

module.exports = { createFingerprint, classifyFailure, FAILURE_CLASSES }
