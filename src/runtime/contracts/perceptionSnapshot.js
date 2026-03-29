/**
 * Tiered Perception Snapshot Contract
 *
 * Four tiers, each serving a different runtime consumer:
 *   reflex    – fast boolean flags for emergency rules
 *   execution – body state needed during skill/chain execution
 *   decision  – structured data for planner / central reasoning
 *   semantic  – higher-level labels for LLM prompt and personality
 */

function buildTieredSnapshot({
  bot,
  status,
  inventory,
  blocks,
  entities,
  farResources,
  threat,
  closeThreat,
  nearestHostileDist,
  bands,
  resources,
  obstacles,
}, extras = {}) {
  const ts = Date.now()

  const reflex = Object.freeze({
    inWater: !!bot?.entity?.isInWater,
    onFire: !!bot?.entity?.isOnFire,
    isInLava: !!bot?.entity?.isInLava,
    fallingRisk: (bot?.entity?.onGround === false && (bot?.entity?.velocity?.y ?? 0) < -0.25),
    closeThreat: !!closeThreat,
    recentDamageMs: extras.recentDamageMs ?? null,
    damageSource: extras.damageSource ?? null,
    stuckLikely: !!extras.stuckLikely,
    health: status?.health ?? 20,
    onGround: bot?.entity?.onGround ?? true,
    velocity: bot?.entity?.velocity ?? null,
  })

  const execution = Object.freeze({
    position: status?.position ?? null,
    velocity: bot?.entity?.velocity ?? null,
    health: status?.health ?? 20,
    food: status?.food ?? 20,
    heldItem: bot?.heldItem?.name ?? null,
    onGround: bot?.entity?.onGround ?? true,
    nearbyBlocks: blocks ?? [],
    nearbyEntities: entities ?? [],
    immediateObstacles: obstacles ?? {},
  })

  const decision = Object.freeze({
    threatLevel: threat ?? 'none',
    closeThreat: !!closeThreat,
    nearestHostileDistance: nearestHostileDist ?? null,
    threatBands: bands ?? {},
    nearbyHostiles: (entities ?? []).filter((e) => {
      const n = (e.name || e.kind || '').toLowerCase()
      return _HOSTILE_SET.has(n)
    }),
    nearbyResources: resources ?? [],
    farResources: farResources ?? [],
    usefulStations: (blocks ?? []).filter((b) =>
      b.name === 'crafting_table' || b.name === 'furnace' || b.name === 'chest'
    ),
    inventorySummary: inventory?.summary ?? [],
    inventorySlotsUsed: inventory?.slotsUsed ?? 0,
    currentGoalProgress: extras.goalProgress ?? null,
  })

  const semantic = Object.freeze({
    areaSafetyLabel: _deriveSafetyLabel(threat, status),
    opportunityHints: _deriveOpportunityHints(farResources, resources),
    memoryHints: extras.memoryHints ?? [],
    capabilityHints: extras.capabilityHints ?? [],
    personalityModifiers: extras.personalityModifiers ?? {},
  })

  // Legacy flat snapshot for backward compatibility during migration.
  // Consumers should migrate to tier-specific access.
  const flat = Object.freeze({
    ts,
    status: Object.freeze({ ...(status ?? {}), recentDamageMs: extras.recentDamageMs ?? null, damageSource: extras.damageSource ?? null }),
    inventory: inventory ?? { slotsUsed: 0, summary: [] },
    nearby: Object.freeze({
      blocks: blocks ?? [],
      entities: (entities ?? []).slice(0, 5),
    }),
    farResources: farResources ?? [],
    threat_level: threat ?? 'none',
    close_threat: !!closeThreat,
    nearest_hostile_distance: nearestHostileDist ?? null,
    threat_bands: bands ?? {},
    resources: resources ?? [],
    obstacles: obstacles ?? {},
  })

  return Object.freeze({
    ts,
    reflex,
    execution,
    decision,
    semantic,
    flat,
  })
}

// --- internal helpers ---

// Shared hostile set (matches sense.js HOSTILE_MOBS)
const _HOSTILE_SET = new Set([
  'zombie', 'skeleton', 'creeper', 'spider', 'cave_spider', 'enderman',
  'witch', 'slime', 'magma_cube', 'blaze', 'ghast', 'wither_skeleton',
  'phantom', 'drowned', 'husk', 'stray', 'pillager', 'vindicator',
  'ravager', 'evoker', 'vex', 'hoglin', 'piglin_brute', 'warden',
  'zombified_piglin', 'guardian', 'elder_guardian', 'shulker',
])

function _deriveSafetyLabel(threat, status) {
  if (threat === 'high') return 'dangerous'
  if (threat === 'low') return 'cautious'
  if (status?.isNight) return 'risky_night'
  return 'safe'
}

function _deriveOpportunityHints(farResources, nearResources) {
  const hints = []
  if (farResources?.length > 0) {
    const oreNearby = farResources.some((r) => r.name?.includes('ore'))
    if (oreNearby) hints.push('ore_nearby')
    const woodNearby = farResources.some((r) => r.name?.includes('log'))
    if (woodNearby) hints.push('wood_nearby')
  }
  if (nearResources?.length > 0) {
    for (const r of nearResources) {
      if (r.type === 'ore' && r.count >= 3) hints.push('ore_cluster_close')
      if (r.type === 'wood' && r.count >= 3) hints.push('wood_cluster_close')
    }
  }
  return hints
}

module.exports = { buildTieredSnapshot }
