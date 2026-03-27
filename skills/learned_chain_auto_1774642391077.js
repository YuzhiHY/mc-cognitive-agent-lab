// Auto-generated from stable action chain: learned_chain
module.exports.run = async ({ api, ctx }) => {
  try {
    await api.navigateToNearestBlock("dirt", 32, { sprint:false })
    await api.digByName("dirt", { maxDistance: 20, navigate: true })
    return { done: true, learned: true }
  } catch (err) {
    return { done: false, error: err?.message || String(err) }
  }
}
