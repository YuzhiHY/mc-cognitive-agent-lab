const assert = require('node:assert')
const { compileActionChain } = require('../src/runtime/planning/chainCompiler')

async function testPairCompaction() {
  const out = compileActionChain({
    goal: 'collect wood',
    snapshot: { threat_level: 'none' },
    actionChain: [
      { type: 'navigate', target: 'nearest_oak_log', sprint: true },
      { type: 'dig', target: 'oak_log' },
    ],
  })
  assert.strictEqual(out[0].type, 'skill_ref')
  assert.strictEqual(out[0].name, 'approach_target')
  assert.strictEqual(out[1].type, 'skill_ref')
  assert.strictEqual(out[1].name, 'mine_named_block')
}

async function testThreatPrependCombat() {
  const out = compileActionChain({
    goal: 'say hello',
    snapshot: { threat_level: 'high', close_threat: true, status: { health: 18, recentDamageMs: 200 } },
    actionChain: [{ type: 'chat', message: 'hi' }],
  })
  assert.strictEqual(out[0].type, 'skill_ref')
  assert.strictEqual(out[0].name, 'attack_nearest_hostile')
}

async function testTorchToSkillRef() {
  const out = compileActionChain({
    goal: 'light',
    snapshot: { threat_level: 'none' },
    actionChain: [{ type: 'torch', count: 1 }],
  })
  assert.strictEqual(out[0].type, 'skill_ref')
  assert.strictEqual(out[0].name, 'place_torch_safely')
}

async function run() {
  await testPairCompaction()
  await testThreatPrependCombat()
  await testTorchToSkillRef()
  // eslint-disable-next-line no-console
  console.log('planning chain compiler tests passed')
}

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err)
  process.exit(1)
})

