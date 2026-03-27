const { okSkill, failSkill, pickBestFoodName } = require('./_helpers')

module.exports = Object.freeze({
  name: 'eat_best_food',
  category: 'survival',
  description: 'Eat best available food item.',
  timeoutMs: 6000,
  canInterrupt: true,
  tags: ['eat', 'survival'],
  riskLevel: 'low',
  preconditions: ({ ctx }) => {
    const inv = Array.isArray(ctx?.snapshot?.inventory?.summary) ? ctx.snapshot.inventory.summary : []
    const name = pickBestFoodName(inv)
    return { ok: !!name, reason: name ? 'ok' : 'no_food' }
  },
  execute: async ({ api, ctx, startedAt }) => {
    try {
      const inv = Array.isArray(ctx?.snapshot?.inventory?.summary) ? ctx.snapshot.inventory.summary : []
      const foodName = pickBestFoodName(inv)
      if (!foodName) throw new Error('no_food')
      const out = await api.executeAction('eatFood', { item: foodName })
      if (out?.status !== 'success') throw new Error(out?.errorMessage || 'eat_failed')
      return okSkill({ skillName: 'eat_best_food', startedAt, reason: 'eat_done', output: { item: foodName } })
    } catch (err) {
      return failSkill({ skillName: 'eat_best_food', startedAt, reason: 'eat_failed', err })
    }
  },
})

