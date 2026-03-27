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
    entity: { id: 1, position: makeVec3(), pitch: 0, onGround: true, velocity: { y: 0 }, eyeHeight: 1.62 },
    entities: {},
    inventory: { items: () => [] },
    pathfinder: { setGoal: () => {} },
    on: () => {},
    setControlState: () => {},
    look: async () => {},
    lookAt: async () => {},
    equip: async () => {},
    attack: () => {},
    blockAt: () => ({ name: 'stone', position: makeVec3(), shapes: [[0, 1, 0, 1, 0, 1]] }),
  }
}

async function testRecentDamageSnapshotRule() {
  const bot = makeBot()
  const reflex = createReflexLayer(bot)
  const out = reflex.arbitrate({
    threat_level: 'high',
    close_threat: true,
    nearby: { blocks: [], entities: [] },
    status: { health: 16, food: 20, recentDamageMs: 400 },
    inventory: { summary: [] },
  }, { cycle: 1 })
  assert.strictEqual(out.decision.shouldInterrupt, true)
  assert.strictEqual(out.decision.metadata.ruleId, 'recent_damage_snapshot_flee')
}

async function testDamageFallbackFactory() {
  const bot = makeBot()
  const reflex = createReflexLayer(bot)
  const fb = reflex.getDamageFallbackAction()
  assert.strictEqual(fb.id, 'damage_fallback_flee')
  assert.strictEqual(typeof fb.execute, 'function')
}

async function testFallingRiskLowerVelocity() {
  const bot = makeBot()
  bot.entity.onGround = false
  bot.entity.velocity = { y: -0.35 }
  const reflex = createReflexLayer(bot)
  const out = reflex.arbitrate({
    threat_level: 'low',
    close_threat: false,
    nearby: { blocks: [], entities: [] },
    status: { health: 20, food: 20 },
    inventory: { summary: [] },
  }, { cycle: 2 })
  assert.strictEqual(out.decision.shouldInterrupt, true)
  assert.strictEqual(out.decision.priority, 'fatal_immediate')
}

async function run() {
  await testRecentDamageSnapshotRule()
  await testDamageFallbackFactory()
  await testFallingRiskLowerVelocity()
  // eslint-disable-next-line no-console
  console.log('reflex damage fallback tests passed')
}

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err)
  process.exit(1)
})
