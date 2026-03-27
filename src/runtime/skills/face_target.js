const { okSkill, failSkill } = require('./_helpers')

module.exports = Object.freeze({
  name: 'face_target',
  category: 'movement',
  description: 'Face the target position.',
  timeoutMs: 2500,
  canInterrupt: true,
  tags: ['movement', 'look'],
  riskLevel: 'low',
  preconditions: ({ args }) => ({ ok: !!args?.position, reason: 'missing_position' }),
  execute: async ({ api, args, startedAt }) => {
    try {
      await api.lookAt(args.position, true)
      return okSkill({ skillName: 'face_target', startedAt, reason: 'face_done' })
    } catch (err) {
      return failSkill({ skillName: 'face_target', startedAt, reason: 'face_failed', err })
    }
  },
})

