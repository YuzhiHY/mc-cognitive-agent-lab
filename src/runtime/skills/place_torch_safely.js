const { okSkill, failSkill } = require('./_helpers')

module.exports = Object.freeze({
  name: 'place_torch_safely',
  category: 'utility',
  description: 'Place torch using stable placement helper.',
  timeoutMs: 4500,
  canInterrupt: true,
  tags: ['torch', 'light'],
  riskLevel: 'low',
  preconditions: () => ({ ok: true }),
  execute: async ({ api, args, startedAt }) => {
    try {
      const out = await api.executeAction('placeTorchSmart', {
        options: {
          count: args?.count || 1,
          itemName: args?.item || 'torch',
          radius: args?.radius || 3,
          force: args?.force === true,
        },
      })
      if (out?.status !== 'success') throw new Error(out?.errorMessage || 'torch_failed')
      return okSkill({ skillName: 'place_torch_safely', startedAt, reason: 'torch_done', output: out.details })
    } catch (err) {
      return failSkill({ skillName: 'place_torch_safely', startedAt, reason: 'torch_failed', err })
    }
  },
})

