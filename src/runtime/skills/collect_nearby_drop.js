const { okSkill, failSkill } = require('./_helpers')

module.exports = Object.freeze({
  name: 'collect_nearby_drop',
  category: 'gather',
  description: 'Collect nearby dropped entities.',
  timeoutMs: 4500,
  canInterrupt: true,
  tags: ['gather', 'loot'],
  riskLevel: 'low',
  preconditions: () => ({ ok: true }),
  execute: async ({ api, args, startedAt }) => {
    try {
      const out = await api.collectNearbyDrops({
        maxDistance: args?.maxDistance || 5,
        timeoutMs: args?.timeoutMs || 2500,
        anchorPos: args?.anchorPos || null,
      })
      return okSkill({ skillName: 'collect_nearby_drop', startedAt, reason: 'collect_done', output: out })
    } catch (err) {
      return failSkill({ skillName: 'collect_nearby_drop', startedAt, reason: 'collect_failed', err })
    }
  },
})

