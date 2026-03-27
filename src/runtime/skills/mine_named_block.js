const { okSkill, failSkill } = require('./_helpers')

module.exports = Object.freeze({
  name: 'mine_named_block',
  category: 'gather',
  description: 'Mine a target block by name.',
  timeoutMs: 18000,
  canInterrupt: true,
  tags: ['mine', 'gather'],
  riskLevel: 'medium',
  preconditions: ({ args }) => ({ ok: !!args?.block, reason: 'missing_block' }),
  execute: async ({ api, args, startedAt }) => {
    try {
      const out = await api.executeAction('digByName', {
        name: args.block,
        options: { maxDistance: args?.maxDistance || 20, navigate: true },
      })
      if (out?.status !== 'success') throw new Error(out?.errorMessage || 'mine_failed')
      return okSkill({ skillName: 'mine_named_block', startedAt, reason: 'mine_done', output: out.details })
    } catch (err) {
      return failSkill({ skillName: 'mine_named_block', startedAt, reason: 'mine_failed', err })
    }
  },
})

