const { okSkill, failSkill } = require('./_helpers')

module.exports = Object.freeze({
  name: 'simple_craft_item',
  category: 'craft',
  description: 'Craft item through stable craft path.',
  timeoutMs: 12000,
  canInterrupt: true,
  tags: ['craft'],
  riskLevel: 'low',
  preconditions: ({ args }) => ({ ok: !!args?.item, reason: 'missing_item' }),
  execute: async ({ api, args, startedAt }) => {
    try {
      const out = await api.executeAction('craftAny', { item: args.item, count: args?.count || 1 })
      if (out?.status !== 'success') throw new Error(out?.errorMessage || 'craft_failed')
      return okSkill({ skillName: 'simple_craft_item', startedAt, reason: 'craft_done', output: out.details })
    } catch (err) {
      return failSkill({ skillName: 'simple_craft_item', startedAt, reason: 'craft_failed', err })
    }
  },
})

