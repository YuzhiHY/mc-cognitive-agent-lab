const assert = require('node:assert')
const { createReflexLayer } = require('../src/runtime/reflexLayer')

function makeVec3(x = 0, y = 64, z = 0) {
  return {
    x, y, z,
    distanceTo(v) {
      const dx = this.x - v.x
      const dy = this.y - v.y
      const dz = this.z - v.z
      return Math.sqrt(dx * dx + dy * dy + dz * dz)
    },
    offset(dx, dy, dz) {
      return makeVec3(this.x + dx, this.y + dy, this.z + dz)
    },
    floored() {
      return makeVec3(Math.floor(this.x), Math.floor(this.y), Math.floor(this.z))
    },
  }
}

function makeBot() {
  return {
    health: 20,
    entity: { id: 1, position: makeVec3(), pitch: 0 },
    entities: {},
    inventory: { items: () => [] },
    pathfinder: { setGoal: () => {} },
    on: () => {},
    setControlState: () => {},
    look: async () => {},
    lookAt: async () => {},
    equip: async () => {},
    attack: () => {},
  }
}

async function testInterruptShape() {
  const bot = makeBot()
  const reflex = createReflexLayer(bot)
  const out = reflex.arbitrate({
    threat_level: 'none',
    close_threat: false,
    nearby: { blocks: [], entities: [] },
    status: { health: 20, food: 20 },
    inventory: { summary: [] },
  }, { cycle: 1 })
  assert.ok(out.decision, 'arbitrate must return { decision, matchedRule }')
  assert.ok(Object.prototype.hasOwnProperty.call(out.decision, 'shouldInterrupt'))
  assert.ok(Object.prototype.hasOwnProperty.call(out.decision, 'priority'))
  assert.ok(Object.prototype.hasOwnProperty.call(out.decision, 'interruptReason'))
}

async function testFatalImmediateOnLava() {
  const bot = makeBot()
  const reflex = createReflexLayer(bot)
  const out = reflex.arbitrate({
    threat_level: 'high',
    close_threat: true,
    nearby: { blocks: [{ name: 'lava', distance: 1.2 }], entities: [] },
    status: { health: 14, food: 20 },
    inventory: { summary: [] },
  }, { cycle: 2 })
  assert.strictEqual(out.decision.shouldInterrupt, true)
  assert.strictEqual(out.decision.priority, 'fatal_immediate')
}

async function testHighPriorityRecentDamageWindow() {
  const bot = makeBot()
  bot.entities = {
    2: { id: 2, name: 'zombie', position: makeVec3(1.5, 64, 0), isValid: true },
  }
  const reflex = createReflexLayer(bot)
  const out = reflex.arbitrate({
    threat_level: 'high',
    close_threat: true,
    nearby: { blocks: [], entities: [{ name: 'zombie', distance: 1.5 }] },
    status: { health: 16, food: 20, recentDamageMs: 500 },
    inventory: { summary: [] },
  }, { cycle: 3 })
  assert.strictEqual(out.decision.shouldInterrupt, true)
  assert.ok(['high', 'fatal_immediate', 'medium'].includes(out.decision.priority))
}

async function testUnsafeWaterScenario() {
  const bot = makeBot()
  bot.entity.isInWater = true
  bot.oxygenLevel = 4
  const reflex = createReflexLayer(bot)
  const out = reflex.arbitrate({
    threat_level: 'low',
    close_threat: false,
    nearby: { blocks: [{ name: 'water', distance: 1 }], entities: [] },
    status: { health: 12, food: 20 },
    inventory: { summary: [] },
    reflexContext: { inWater: true, oxygenLevel: 4, health: 12, food: 20 },
  }, { cycle: 4 })
  assert.strictEqual(out.decision.shouldInterrupt, true)
  assert.ok(['high', 'fatal_immediate', 'medium'].includes(out.decision.priority))
}

async function testFireBurnScenario() {
  const bot = makeBot()
  bot.entity.isOnFire = true
  const reflex = createReflexLayer(bot)
  const out = reflex.arbitrate({
    threat_level: 'high',
    close_threat: true,
    nearby: { blocks: [], entities: [] },
    status: { health: 14, food: 20 },
    inventory: { summary: [] },
    reflexContext: { onFire: true, health: 14, food: 20 },
  }, { cycle: 5 })
  assert.strictEqual(out.decision.shouldInterrupt, true)
  assert.ok(['high', 'fatal_immediate'].includes(out.decision.priority))
}

async function testFallingRiskScenario() {
  const bot = makeBot()
  bot.entity.onGround = false
  bot.entity.velocity = { y: -1.2 }
  const reflex = createReflexLayer(bot)
  const out = reflex.arbitrate({
    threat_level: 'low',
    close_threat: false,
    nearby: { blocks: [], entities: [] },
    status: { health: 20, food: 20 },
    inventory: { summary: [] },
    reflexContext: { onGround: false, vy: -1.2, belowAir: true, below2Air: true, health: 20, food: 20 },
  }, { cycle: 6 })
  assert.strictEqual(out.decision.shouldInterrupt, true)
  assert.strictEqual(out.decision.priority, 'fatal_immediate')
}

async function testRepeatedStuckDoesNotTriggerReflex() {
  // Per CLAUDE.md: stuck is NOT a survival threat. Reflex layer must NOT
  // handle it — the planner decides the response in the next cycle.
  const bot = makeBot()
  const reflex = createReflexLayer(bot)
  reflex.noteStuck()
  reflex.noteStuck()
  const out = reflex.arbitrate({
    threat_level: 'none',
    close_threat: false,
    nearby: { blocks: [], entities: [] },
    status: { health: 20, food: 20 },
    inventory: { summary: [] },
  }, { cycle: 7 })
  assert.strictEqual(out.decision.shouldInterrupt, false, 'stuck alone must not trigger reflex interrupt')
}

async function testDamageBurstScenario() {
  const bot = makeBot()
  const reflex = createReflexLayer(bot)
  reflex.noteDamage()
  reflex.noteDamage()
  const out = reflex.arbitrate({
    threat_level: 'high',
    close_threat: true,
    nearby: { blocks: [], entities: [{ name: 'zombie', distance: 2.1 }] },
    status: { health: 12, food: 20 },
    inventory: { summary: [] },
  }, { cycle: 8 })
  assert.strictEqual(out.decision.shouldInterrupt, true)
  assert.ok(['high', 'fatal_immediate', 'medium'].includes(out.decision.priority))
}

async function run() {
  await testInterruptShape()
  await testFatalImmediateOnLava()
  await testHighPriorityRecentDamageWindow()
  await testUnsafeWaterScenario()
  await testFireBurnScenario()
  await testFallingRiskScenario()
  await testRepeatedStuckDoesNotTriggerReflex()
  await testDamageBurstScenario()
  // eslint-disable-next-line no-console
  console.log('reflex arbitration tests passed')
}

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err)
  process.exit(1)
})

