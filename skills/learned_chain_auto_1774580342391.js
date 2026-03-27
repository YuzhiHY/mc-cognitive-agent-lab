// Auto-generated from stable action chain: learned_chain
module.exports.run = async ({ api, ctx }) => {
  try {
    await api.navigateToNearestBlock("oak_log", 32, { sprint:true })
    await api.digByName("oak_log", { maxDistance: 20, navigate: true })
    return { done: true, learned: true }
  } catch (err) {
    return { done: false, error: err?.message || String(err) }
  }
}
