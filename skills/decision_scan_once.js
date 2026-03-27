module.exports.run = async ({ api, ctx }) => {
  const blocks = ctx?.snapshot?.nearby?.blocks || []
  const entities = ctx?.snapshot?.nearby?.entities || []
  const inv = ctx?.snapshot?.inventory?.summary || []

  const blockNames = blocks.map((b) => b.name)
  const entityNames = entities.map((e) => e.name || e.type || 'unknown')

  const risks = []
  if (entityNames.some((n) => String(n).includes('zombie') || String(n).includes('creeper'))) {
    risks.push('hostile_entity_nearby')
  }

  const targets = {
    blocks: Array.from(new Set(blockNames)).slice(0, 10),
    entities: Array.from(new Set(entityNames)).slice(0, 10)
  }

  const decision = {
    summary: `blocks=${blocks.length}, entities=${entities.length}, invKinds=${inv.length}`,
    risks,
    targets,
    recommendation: {
      next: risks.length ? 'be_cautious' : 'continue_observing',
      why: risks.length ? 'Potential hostile entity nearby' : 'No immediate risks detected'
    }
  }

  api.chat(`[decision] ${decision.summary}`)
  return { done: true, decision }
}
