const { invalidResult } = require('./executionResult')

function validateSkillContract(skill) {
  if (!skill || typeof skill !== 'object') return { ok: false, reason: 'skill_not_object' }
  if (!skill.name || typeof skill.name !== 'string') return { ok: false, reason: 'missing_name' }
  if (!skill.category || typeof skill.category !== 'string') return { ok: false, reason: 'missing_category' }
  if (!skill.description || typeof skill.description !== 'string') return { ok: false, reason: 'missing_description' }
  if (typeof skill.preconditions !== 'function') return { ok: false, reason: 'missing_preconditions' }
  if (typeof skill.execute !== 'function') return { ok: false, reason: 'missing_execute' }
  if (typeof skill.canInterrupt !== 'boolean') return { ok: false, reason: 'missing_canInterrupt' }
  if (!Number.isFinite(skill.timeoutMs) || skill.timeoutMs <= 0) return { ok: false, reason: 'invalid_timeoutMs' }
  if (!Array.isArray(skill.tags)) return { ok: false, reason: 'invalid_tags' }
  if (!['low', 'medium', 'high'].includes(skill.riskLevel)) return { ok: false, reason: 'invalid_riskLevel' }
  return { ok: true }
}

async function runSkillWithContract({
  skill,
  api,
  bot,
  ctx,
  args = {},
}) {
  const startedAt = Date.now()
  const contract = validateSkillContract(skill)
  if (!contract.ok) {
    return invalidResult({
      source: 'skill',
      actionType: skill?.name || 'unknown_skill',
      startedAt,
      endedAt: Date.now(),
      reason: `invalid_skill_contract:${contract.reason}`,
      errorMessage: contract.reason,
    })
  }

  const pre = await Promise.resolve(skill.preconditions({ api, bot, ctx, args }))
  if (!pre?.ok) {
    return invalidResult({
      source: 'skill',
      actionType: skill.name,
      skillName: skill.name,
      startedAt,
      endedAt: Date.now(),
      reason: 'precondition_failed',
      errorMessage: pre?.reason || 'precondition_failed',
      details: { precondition: pre || null },
    })
  }

  return skill.execute({
    api,
    bot,
    ctx,
    args,
    startedAt,
  })
}

module.exports = {
  validateSkillContract,
  runSkillWithContract,
}

