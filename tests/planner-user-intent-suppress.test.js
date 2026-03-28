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
  const { buildIntentAwareChain } = require('../src/runtime/planning/intentFallback')
  // "explore" is now recognized — produces approach action
  const chain1 = buildIntentAwareChain({ goalText: 'explore the jungle biome', playerTexts: [] })
  assert.ok(chain1.length > 0, 'explore intent should produce actions')
  assert.notStrictEqual(chain1[0]?.name, 'recover_from_stuck', 'explore should not trigger recovery')

  // "go to" is now recognized — produces navigation
  const chain2 = buildIntentAwareChain({ goalText: '', playerTexts: ['go to jungle'] })
  assert.ok(chain2.length > 0, 'go to intent should produce actions')

  // "come here" / "follow me" — produces player navigation
  const chain3 = buildIntentAwareChain({ goalText: '', playerTexts: ['come here'] })
  assert.ok(chain3.length > 0, 'come here should produce navigate action')
  assert.strictEqual(chain3[0]?.target, 'nearest_player')

  // Truly unrecognized intent (no keywords at all) still returns empty
  const chain4 = buildIntentAwareChain({ goalText: 'do something philosophical', playerTexts: [] })
  assert.deepStrictEqual(chain4, [], 'completely unrecognized should return empty')
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
