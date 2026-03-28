const assert = require('node:assert')
const { compileActionChain } = require('../src/runtime/planning/chainCompiler')
const { chooseHardcodedSkill } = require('../src/runtime/planning/skillSelector')

async function testEmptyExplicitIntentDoesNotSpinOnWait() {
  const out = compileActionChain({
    goal: 'build a tower',
    snapshot: { threat_level: 'none', nearby: { blocks: [{ name: 'oak_log' }] } },
    actionChain: [],
    planningContext: { explicitUserIntent: true, goalText: 'build a tower' },
  })
  assert.ok(out.length >= 1, 'expected a concrete fallback chain')
  assert.notStrictEqual(out[0].type, 'wait', 'explicit intent must advance via skills, not wait')
  assert.strictEqual(out[0].type, 'skill_ref')
  assert.ok(out[0].name && out[0].name.length > 0)
}

async function testSuppressWoodSkillWithoutWoodGoal() {
  const sel = chooseHardcodedSkill({
    goal: 'follow the redstone tutorial',
    snapshot: { threat_level: 'none', status: { health: 20, food: 20 }, inventory: { summary: [] } },
    options: { suppressWoodGather: true },
  })
  assert.notStrictEqual(sel?.name, 'mine_named_block')
}

async function testAllowsWoodWhenGoalMentionsWood() {
  const sel = chooseHardcodedSkill({
    goal: 'chop oak_log for planks',
    snapshot: { threat_level: 'none', status: { health: 20, food: 20 }, inventory: { summary: [] } },
    options: { suppressWoodGather: true },
  })
  assert.strictEqual(sel?.name, 'mine_named_block')
}

async function testUnrecognizedIntentDoesNotForceRecovery() {
  // Simulate quickFallbackDecision path:
  // buildIntentAwareChain returns [] for unrecognized intent
  const { buildIntentAwareChain } = require('../src/runtime/planning/intentFallback')
  const chain = buildIntentAwareChain({ goalText: 'explore the jungle biome', playerTexts: ['go to jungle'] })
  // Intent doesn't match any keyword — should return empty array
  assert.deepStrictEqual(chain, [], 'unrecognized intent should return empty from buildIntentAwareChain')
  // The centralReasoning quickFallbackDecision now returns null for this case
  // instead of forcing recover_from_stuck — verify the contract
}

async function run() {
  await testEmptyExplicitIntentDoesNotSpinOnWait()
  await testSuppressWoodSkillWithoutWoodGoal()
  await testAllowsWoodWhenGoalMentionsWood()
  await testUnrecognizedIntentDoesNotForceRecovery()
  // eslint-disable-next-line no-console
  console.log('planner user intent suppress tests passed')
}

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err)
  process.exit(1)
})
