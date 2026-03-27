const { okSkill, failSkill } = require('./_helpers')

module.exports = Object.freeze({
  name: 'attack_nearest_hostile',
  category: 'combat',
  description: 'Attack nearest hostile entity.',
  timeoutMs: 6000,
  canInterrupt: true,
  tags: ['combat', 'attack'],
  riskLevel: 'medium',
  preconditions: () => ({ ok: true }),
  execute: async ({ api, startedAt }) => {
    try {
      const out = await api.executeAction('attackNearest', {})
      if (out?.status !== 'success') throw new Error(out?.errorMessage || 'attack_failed')
      return okSkill({ skillName: 'attack_nearest_hostile', startedAt, reason: 'attack_done', output: out.details })
    } catch (err) {
      return failSkill({ skillName: 'attack_nearest_hostile', startedAt, reason: 'attack_failed', err })
    }
  },
})

