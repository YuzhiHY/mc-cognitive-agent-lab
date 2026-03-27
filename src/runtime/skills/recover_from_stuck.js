const { okSkill, failSkill } = require('./_helpers')

module.exports = Object.freeze({
  name: 'recover_from_stuck',
  category: 'recovery',
  description: 'Clear obstacle and hop once to recover movement.',
  timeoutMs: 3500,
  canInterrupt: true,
  tags: ['recovery', 'stuck'],
  riskLevel: 'low',
  preconditions: () => ({ ok: true }),
  execute: async ({ api, startedAt }) => {
    try {
      const out = await api.executeAction('recoverFromStuck', {})
      if (out?.status !== 'success') throw new Error(out?.errorMessage || 'recover_failed')
      return okSkill({ skillName: 'recover_from_stuck', startedAt, reason: 'recover_done', output: out.details })
    } catch (err) {
      return failSkill({ skillName: 'recover_from_stuck', startedAt, reason: 'recover_failed', err })
    }
  },
})

