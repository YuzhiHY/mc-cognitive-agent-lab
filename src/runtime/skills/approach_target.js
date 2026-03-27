const { okSkill, failSkill } = require('./_helpers')

module.exports = Object.freeze({
  name: 'approach_target',
  category: 'movement',
  description: 'Move toward position or nearest target block.',
  timeoutMs: 12000,
  canInterrupt: true,
  tags: ['movement', 'approach'],
  riskLevel: 'low',
  preconditions: ({ args }) => ({ ok: !!(args?.position || args?.target), reason: 'missing_target' }),
  execute: async ({ api, args, startedAt }) => {
    try {
      const out = args?.position
        ? await api.navigateTo(args.position, { sprint: !!args?.sprint, timeoutMs: args?.timeoutMs || 9000 })
        : await api.navigateToNearestBlock(args?.target, args?.maxDistance || 32, { sprint: !!args?.sprint })
      return okSkill({ skillName: 'approach_target', startedAt, reason: 'approach_done', output: out })
    } catch (err) {
      return failSkill({ skillName: 'approach_target', startedAt, reason: 'approach_failed', err })
    }
  },
})

