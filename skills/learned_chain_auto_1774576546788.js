// Auto-generated from stable action chain: learned_chain
module.exports.run = async ({ api, ctx }) => {
  try {
    await api.navigateToNearestBlock("player", 32, { sprint:false })
    await api.chat("Rinllo_，你建议往地下挖安全屋，但我附近没有泥土方块。你能指点一下哪里有泥土吗？或者我需要先做什么准备？")
    return { done: true, learned: true }
  } catch (err) {
    return { done: false, error: err?.message || String(err) }
  }
}
