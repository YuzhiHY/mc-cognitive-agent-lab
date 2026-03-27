const { okSkill, failSkill } = require('./_helpers')

module.exports = Object.freeze({
  name: 'retreat_from_threat',
  category: 'combat',
  description: 'Short burst retreat from nearest threat.',
  timeoutMs: 3000,
  canInterrupt: true,
  tags: ['combat', 'retreat'],
  riskLevel: 'medium',
  preconditions: () => ({ ok: true }),
  execute: async ({ api, startedAt }) => {
    try {
      const out = await api.executeAction('retreatFromThreat', {})
      if (out?.status !== 'success') throw new Error(out?.errorMessage || 'retreat_failed')
      return okSkill({ skillName: 'retreat_from_threat', startedAt, reason: 'retreat_done', output: out.details })
    } catch (err) {
      return failSkill({ skillName: 'retreat_from_threat', startedAt, reason: 'retreat_failed', err })
    }
  },
})

