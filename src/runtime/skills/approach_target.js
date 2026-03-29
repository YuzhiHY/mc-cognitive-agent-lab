const { okSkill, failSkill } = require('./_helpers')

/**
 * Resolve a player entity position from bot.entities.
 * Returns {x, y, z} or null.
 */
function findNearestPlayerPos(bot) {
  const origin = bot.entity?.position
  if (!origin) return null
  let best = null
  let bestDist = Infinity
  for (const e of Object.values(bot.entities || {})) {
    if (!e?.position || e.id === bot.entity?.id) continue
    if (e.type !== 'player' && !e.username) continue
    const d = origin.distanceTo(e.position)
    if (d < bestDist) { bestDist = d; best = e.position }
  }
  if (!best) return null
  return { x: best.x, y: best.y, z: best.z }
}

function isPlayerTarget(target) {
  const t = String(target || '').toLowerCase()
  return t === 'nearest_player' || t === 'player'
}

module.exports = Object.freeze({
  name: 'approach_target',
  category: 'movement',
  description: 'Move toward position, nearest target block, or nearest player.',
  timeoutMs: 12000,
  canInterrupt: true,
  tags: ['movement', 'approach'],
  riskLevel: 'low',
  preconditions: ({ args }) => ({ ok: !!(args?.position || args?.target), reason: 'missing_target' }),
  execute: async ({ api, bot, args, startedAt }) => {
    try {
      if (args?.position) {
        const out = await api.navigateTo(args.position, { sprint: !!args?.sprint, timeoutMs: args?.timeoutMs || 9000 })
        return okSkill({ skillName: 'approach_target', startedAt, reason: 'approach_done', output: out })
      }
      // Handle player targets — resolve live entity position, not block
      if (isPlayerTarget(args?.target)) {
        const playerPos = findNearestPlayerPos(bot)
        if (!playerPos) return failSkill({ skillName: 'approach_target', startedAt, reason: 'no_player_found' })
        const out = await api.navigateTo(playerPos, { sprint: !!args?.sprint, timeoutMs: args?.timeoutMs || 9000 })
        return okSkill({ skillName: 'approach_target', startedAt, reason: 'approach_done', output: out })
      }
      // Standard block target — strip 'nearest_' prefix if LLM passed it through
      const rawTarget = String(args?.target || '').replace(/^nearest_/, '')
      const out = await api.navigateToNearestBlock(rawTarget, args?.maxDistance || 32, { sprint: !!args?.sprint })
      return okSkill({ skillName: 'approach_target', startedAt, reason: 'approach_done', output: out })
    } catch (err) {
      return failSkill({ skillName: 'approach_target', startedAt, reason: 'approach_failed', err })
    }
  },
})

