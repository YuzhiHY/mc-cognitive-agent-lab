const { okSkill, failSkill } = require('./_helpers')

module.exports = Object.freeze({
  name: 'place_named_block',
  category: 'build',
  description: 'Place a named block item nearby.',
  timeoutMs: 12000,
  canInterrupt: true,
  tags: ['place', 'build'],
  riskLevel: 'medium',
  preconditions: ({ args }) => ({ ok: !!args?.item, reason: 'missing_item' }),
  execute: async ({ api, args, startedAt }) => {
    try {
      const out = await api.executeAction('placeNamedBlock', { item: args.item })
      if (out?.status !== 'success') throw new Error(out?.errorMessage || 'place_failed')
      return okSkill({ skillName: 'place_named_block', startedAt, reason: 'place_done', output: out.details })
    } catch (err) {
      return failSkill({ skillName: 'place_named_block', startedAt, reason: 'place_failed', err })
    }
  },
})

