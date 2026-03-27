module.exports.run = async ({ api, bot }) => {
  bot.setControlState('jump', true)
  bot.setControlState('sprint', true)
  bot.setControlState('forward', true)
  await api.sleep(1500)
  bot.setControlState('jump', false)
  bot.setControlState('forward', false)
  bot.setControlState('sprint', false)

  return { done: true, reason: 'emergency jump executed' }
}
