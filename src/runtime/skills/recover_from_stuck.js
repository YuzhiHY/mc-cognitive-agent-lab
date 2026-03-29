const { okSkill, failSkill } = require('./_helpers')
const { feel } = require('../feeler')

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

module.exports = Object.freeze({
  name: 'recover_from_stuck',
  category: 'recovery',
  description: 'Multi-strategy stuck recovery: clear obstacle, random direction, pathfinder reset, jump.',
  timeoutMs: 6000,
  canInterrupt: true,
  tags: ['recovery', 'stuck'],
  riskLevel: 'low',
  preconditions: () => ({ ok: true }),
  execute: async ({ api, bot, startedAt }) => {
    const strategies = []
    try {
      // Strategy 1: Clear pathfinder goal to stop thrashing
      try {
        if (bot?.pathfinder) {
          bot.pathfinder.setGoal(null)
          strategies.push('pathfinder_reset')
        }
      } catch { /* */ }

      // Strategy 2: Clear all control states
      try {
        const controls = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']
        for (const c of controls) bot.setControlState(c, false)
        strategies.push('controls_cleared')
      } catch { /* */ }

      // Strategy 3: Feeler-based micro-compensation (movement-first)
      try {
        const feelerResult = await feel(bot, null, { allowDig: true })
        if (feelerResult.compensated) strategies.push(`feeler_${feelerResult.action}`)
      } catch { /* */ }

      // Strategy 4: Legacy obstacle clear (dig-based fallback)
      try {
        const out = await api.executeAction('recoverFromStuck', {})
        if (out?.status === 'success') strategies.push('obstacle_cleared')
      } catch { /* */ }

      // Strategy 5: Random direction walk to escape collision
      try {
        const angle = Math.random() * Math.PI * 2
        await bot.look(angle, 0, true)
        bot.setControlState('forward', true)
        bot.setControlState('sprint', true)
        await sleep(600)
        bot.setControlState('forward', false)
        bot.setControlState('sprint', false)
        strategies.push('random_walk')
      } catch { /* */ }

      // Strategy 5: Jump to clear small ledges
      try {
        bot.setControlState('jump', true)
        await sleep(300)
        bot.setControlState('jump', false)
        strategies.push('jump')
      } catch { /* */ }

      // Final: clear controls again
      try {
        const controls = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']
        for (const c of controls) bot.setControlState(c, false)
      } catch { /* */ }

      return okSkill({
        skillName: 'recover_from_stuck',
        startedAt,
        reason: 'multi_strategy_recover_done',
        output: { strategies },
      })
    } catch (err) {
      return failSkill({ skillName: 'recover_from_stuck', startedAt, reason: 'recover_failed', err })
    }
  },
})
