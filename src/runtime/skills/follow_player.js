const { okSkill, failSkill } = require('./_helpers')
const { feel } = require('../feeler')

/**
 * Resolve nearest player entity from bot.entities.
 * Returns the entity object (not just position) so we can track movement.
 */
function findNearestPlayer(bot) {
  const origin = bot.entity?.position
  if (!origin) return null
  let best = null
  let bestDist = Infinity
  for (const e of Object.values(bot.entities || {})) {
    if (!e?.position || e.id === bot.entity?.id) continue
    if (e.type !== 'player' && !e.username) continue
    const d = origin.distanceTo(e.position)
    if (d < bestDist) { bestDist = d; best = e }
  }
  return best
}

module.exports = Object.freeze({
  name: 'follow_player',
  category: 'movement',
  description: 'Continuously follow the nearest player in real-time, updating navigation as they move.',
  timeoutMs: 30000,
  canInterrupt: true,
  tags: ['movement', 'follow', 'player'],
  riskLevel: 'low',
  preconditions: () => ({ ok: true, reason: 'always_available' }),
  execute: async ({ api, bot, args, startedAt }) => {
    const followDistance = args?.distance || 3
    const maxDuration = args?.timeoutMs || 25000
    const deadline = Date.now() + maxDuration

    try {
      const { goals } = require('mineflayer-pathfinder')
      if (!bot.pathfinder) {
        return failSkill({ skillName: 'follow_player', startedAt, reason: 'no_pathfinder' })
      }

      let ticksNearPlayer = 0
      const NEAR_THRESHOLD = followDistance + 1
      const RETARGET_INTERVAL = 600 // ms — re-check player position every 600ms

      while (Date.now() < deadline) {
        const player = findNearestPlayer(bot)
        if (!player?.position) {
          return failSkill({ skillName: 'follow_player', startedAt, reason: 'no_player_found' })
        }

        const dist = bot.entity.position.distanceTo(player.position)

        // Already close enough — stay near but don't crowd
        if (dist <= followDistance) {
          try { bot.pathfinder.setGoal(null) } catch { /* */ }
          ticksNearPlayer++
          // If we've been near the player for a while, success
          if (ticksNearPlayer >= 5) {
            return okSkill({
              skillName: 'follow_player', startedAt,
              reason: 'following_stable',
              output: { finalDistance: dist, playerName: player.username || 'unknown' },
            })
          }
          await new Promise((r) => setTimeout(r, RETARGET_INTERVAL))
          continue
        }

        ticksNearPlayer = 0

        // Set dynamic goal toward player — re-target every tick
        const goal = new goals.GoalNear(player.position.x, player.position.y, player.position.z, followDistance)
        bot.pathfinder.setGoal(goal)

        // Feeler: micro-correct if stuck near obstacles while following
        try {
          await feel(bot, player.position, { allowDig: false })
        } catch { /* non-critical */ }

        await new Promise((r) => setTimeout(r, RETARGET_INTERVAL))
      }

      // Timed out but that's normal for a following skill — report where we ended up
      try { bot.pathfinder.setGoal(null) } catch { /* */ }
      const player = findNearestPlayer(bot)
      const finalDist = player?.position
        ? bot.entity.position.distanceTo(player.position)
        : null
      return okSkill({
        skillName: 'follow_player', startedAt,
        reason: 'follow_timeout_normal',
        output: { finalDistance: finalDist, playerName: player?.username || 'unknown' },
      })
    } catch (err) {
      try { bot.pathfinder.setGoal(null) } catch { /* */ }
      return failSkill({ skillName: 'follow_player', startedAt, reason: 'follow_failed', err })
    }
  },
})
