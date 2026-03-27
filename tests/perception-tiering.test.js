const assert = require('node:assert')
const { buildTieredSnapshot } = require('../src/runtime/contracts/perceptionSnapshot')

function makeBot() {
  return {
    entity: {
      isInWater: false,
      isOnFire: false,
      isInLava: false,
      onGround: true,
      velocity: { y: 0 },
      position: { x: 10, y: 64, z: 10 },
    },
    heldItem: { name: 'stone_pickaxe' },
  }
}

function testTieredSnapshotShape() {
  const bot = makeBot()
  const tiered = buildTieredSnapshot({
    bot,
    status: { health: 18, food: 16, position: { x: 10, y: 64, z: 10 }, isNight: false },
    inventory: { slotsUsed: 5, summary: [{ name: 'stone', count: 32 }] },
    blocks: [{ name: 'stone', pos: { x: 9, y: 63, z: 10 } }],
    entities: [{ name: 'zombie', kind: 'hostile', distance: 6 }],
    farResources: [{ name: 'iron_ore', pos: { x: 50, y: 30, z: 50 }, distance: 22 }],
    threat: 'low',
    closeThreat: false,
    nearestHostileDist: 6,
    bands: { within2: 0, within4: 0, within8: 1, closest: 6 },
    resources: [{ type: 'stone', blocks: ['stone'], count: 1 }],
    obstacles: { water: false, lava: false, cliff: false },
  })

  // Top-level structure
  assert.ok(typeof tiered.ts === 'number')
  assert.ok(tiered.reflex)
  assert.ok(tiered.execution)
  assert.ok(tiered.decision)
  assert.ok(tiered.semantic)
  assert.ok(tiered.flat)

  // Reflex tier
  assert.strictEqual(tiered.reflex.inWater, false)
  assert.strictEqual(tiered.reflex.onFire, false)
  assert.strictEqual(tiered.reflex.closeThreat, false)
  assert.strictEqual(tiered.reflex.health, 18)
  assert.strictEqual(tiered.reflex.stuckLikely, false)
  assert.strictEqual(tiered.reflex.recentDamageMs, null)

  // Execution tier
  assert.deepStrictEqual(tiered.execution.position, { x: 10, y: 64, z: 10 })
  assert.strictEqual(tiered.execution.health, 18)
  assert.strictEqual(tiered.execution.food, 16)
  assert.strictEqual(tiered.execution.heldItem, 'stone_pickaxe')
  assert.strictEqual(tiered.execution.nearbyBlocks.length, 1)

  // Decision tier
  assert.strictEqual(tiered.decision.threatLevel, 'low')
  assert.strictEqual(tiered.decision.closeThreat, false)
  assert.strictEqual(tiered.decision.nearestHostileDistance, 6)
  assert.strictEqual(tiered.decision.inventorySummary.length, 1)
  assert.strictEqual(tiered.decision.farResources.length, 1)

  // Semantic tier
  assert.strictEqual(tiered.semantic.areaSafetyLabel, 'cautious')
  assert.ok(tiered.semantic.opportunityHints.includes('ore_nearby'))

  // Flat compat
  assert.strictEqual(tiered.flat.threat_level, 'low')
  assert.strictEqual(tiered.flat.close_threat, false)
  assert.strictEqual(tiered.flat.status.health, 18)
}

function testReflexTierEmergencyFlags() {
  const bot = makeBot()
  bot.entity.isInWater = true
  bot.entity.onGround = false
  bot.entity.velocity = { y: -1.5 }

  const tiered = buildTieredSnapshot({
    bot,
    status: { health: 5, food: 2 },
    inventory: { slotsUsed: 0, summary: [] },
    blocks: [],
    entities: [],
    farResources: [],
    threat: 'high',
    closeThreat: true,
    nearestHostileDist: 2,
    bands: {},
    resources: [],
    obstacles: {},
  }, { recentDamageMs: 300, stuckLikely: true })

  assert.strictEqual(tiered.reflex.inWater, true)
  assert.strictEqual(tiered.reflex.fallingRisk, true)
  assert.strictEqual(tiered.reflex.closeThreat, true)
  assert.strictEqual(tiered.reflex.recentDamageMs, 300)
  assert.strictEqual(tiered.reflex.stuckLikely, true)
  assert.strictEqual(tiered.reflex.health, 5)
}

function testSemanticSafetyLabels() {
  const bot = makeBot()
  const base = { bot, inventory: { slotsUsed: 0, summary: [] }, blocks: [], entities: [], farResources: [], nearestHostileDist: null, bands: {}, resources: [], obstacles: {} }

  const safe = buildTieredSnapshot({ ...base, status: { health: 20 }, threat: 'none', closeThreat: false })
  assert.strictEqual(safe.semantic.areaSafetyLabel, 'safe')

  const dangerous = buildTieredSnapshot({ ...base, status: { health: 8 }, threat: 'high', closeThreat: true })
  assert.strictEqual(dangerous.semantic.areaSafetyLabel, 'dangerous')

  const night = buildTieredSnapshot({ ...base, status: { health: 20, isNight: true }, threat: 'none', closeThreat: false })
  assert.strictEqual(night.semantic.areaSafetyLabel, 'risky_night')
}

function testTiersAreFrozen() {
  const bot = makeBot()
  const tiered = buildTieredSnapshot({
    bot, status: { health: 20 }, inventory: { slotsUsed: 0, summary: [] },
    blocks: [], entities: [], farResources: [], threat: 'none', closeThreat: false,
    nearestHostileDist: null, bands: {}, resources: [], obstacles: {},
  })

  assert.ok(Object.isFrozen(tiered))
  assert.ok(Object.isFrozen(tiered.reflex))
  assert.ok(Object.isFrozen(tiered.execution))
  assert.ok(Object.isFrozen(tiered.decision))
  assert.ok(Object.isFrozen(tiered.semantic))
  assert.ok(Object.isFrozen(tiered.flat))
}

function testFlatCompatHasRecentDamageMs() {
  const bot = makeBot()
  const tiered = buildTieredSnapshot({
    bot, status: { health: 14 }, inventory: { slotsUsed: 0, summary: [] },
    blocks: [], entities: [], farResources: [], threat: 'low', closeThreat: false,
    nearestHostileDist: 8, bands: {}, resources: [], obstacles: {},
  }, { recentDamageMs: 1200 })

  assert.strictEqual(tiered.flat.status.recentDamageMs, 1200)
  assert.strictEqual(tiered.reflex.recentDamageMs, 1200)
}

testTieredSnapshotShape()
testReflexTierEmergencyFlags()
testSemanticSafetyLabels()
testTiersAreFrozen()
testFlatCompatHasRecentDamageMs()
console.log('perception tiering tests passed')
