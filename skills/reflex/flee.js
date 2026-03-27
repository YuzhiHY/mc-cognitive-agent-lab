module.exports.run = async ({ api, bot }) => {
  const origin = bot.entity?.position
  if (!origin) {
    bot.setControlState('sprint', true)
    bot.setControlState('forward', true)
    await api.sleep(2500)
    bot.setControlState('forward', false)
    bot.setControlState('sprint', false)
    return { done: true, reason: 'blind flee — no position data' }
  }

  const hostiles = Object.values(bot.entities || {})
    .filter((e) => e && e.position && e.id !== bot.entity.id && e.type === 'mob')
    .sort((a, b) => a.position.distanceTo(origin) - b.position.distanceTo(origin))

  const threat = hostiles[0]
  if (!threat) {
    bot.setControlState('sprint', true)
    bot.setControlState('forward', true)
    await api.sleep(2000)
    bot.setControlState('forward', false)
    bot.setControlState('sprint', false)
    return { done: true, reason: 'no threat found, moved forward' }
  }

  const dx = origin.x - threat.position.x
  const dz = origin.z - threat.position.z
  const mag = Math.sqrt(dx * dx + dz * dz) || 1
  const fleeTarget = {
    x: origin.x + (dx / mag) * 15,
    y: origin.y,
    z: origin.z + (dz / mag) * 15,
  }

  try {
    await api.navigateTo(fleeTarget, { sprint: true })
  } catch {
    bot.setControlState('sprint', true)
    bot.setControlState('forward', true)
    await api.sleep(3000)
    bot.setControlState('forward', false)
    bot.setControlState('sprint', false)
  }

  return { done: true, reason: 'fled from threat' }
}
