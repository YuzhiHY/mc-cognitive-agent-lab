const { successResult, failureResult } = require('../contracts/executionResult')

function okSkill({ skillName, startedAt, reason, output = null }) {
  return successResult({
    source: 'skill',
    actionType: skillName,
    skillName,
    startedAt,
    endedAt: Date.now(),
    reason: reason || 'skill_done',
    details: output == null ? null : { output },
  })
}

function failSkill({ skillName, startedAt, reason, err }) {
  return failureResult({
    source: 'skill',
    actionType: skillName,
    skillName,
    startedAt,
    endedAt: Date.now(),
    reason: reason || 'skill_failed',
    errorMessage: err?.message || String(err || 'skill_failed'),
  })
}

function pickBestFoodName(items = []) {
  const priority = [
    'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton',
    'cooked_salmon', 'cooked_cod', 'bread', 'baked_potato', 'apple',
    'carrot', 'sweet_berries',
  ]
  const names = new Set(items.map((i) => String(i?.name || '').toLowerCase()))
  return priority.find((n) => names.has(n)) || null
}

module.exports = {
  okSkill,
  failSkill,
  pickBestFoodName,
}

