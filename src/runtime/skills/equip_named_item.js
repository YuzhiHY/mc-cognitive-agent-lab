const { okSkill, failSkill } = require('./_helpers')

module.exports = Object.freeze({
  name: 'equip_named_item',
  category: 'inventory',
  description: 'Equip an inventory item by name.',
  timeoutMs: 2500,
  canInterrupt: true,
  tags: ['equip', 'inventory'],
  riskLevel: 'low',
  preconditions: ({ args }) => ({ ok: !!args?.item, reason: 'missing_item' }),
  execute: async ({ api, args, startedAt }) => {
    try {
      const out = await api.equipByName(args.item, 'hand')
      return okSkill({ skillName: 'equip_named_item', startedAt, reason: 'equip_done', output: out })
    } catch (err) {
      return failSkill({ skillName: 'equip_named_item', startedAt, reason: 'equip_failed', err })
    }
  },
})

