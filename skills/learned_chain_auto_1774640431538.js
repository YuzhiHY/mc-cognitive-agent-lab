// Auto-generated from stable action chain: learned_chain
module.exports.run = async ({ api, ctx }) => {
  try {
    await api.chat("收到，Rinllo_。我先执行一个快速动作，随后继续详细规划。")
    await api.sleep(500)
    return { done: true, learned: true }
  } catch (err) {
    return { done: false, error: err?.message || String(err) }
  }
}
