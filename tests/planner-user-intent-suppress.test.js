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

  // "come here" — produces player navigation
  const chain1 = buildIntentAwareChain({ goalText: '', playerTexts: ['come here'] })
  assert.ok(chain1.length > 0, 'come here should produce navigate action')
  assert.strictEqual(chain1[0]?.target, 'nearest_player')

  // Unrecognized intent returns empty — no false matches on Chinese text
  const chain2 = buildIntentAwareChain({ goalText: '', playerTexts: ['你是不是没看到树在哪？'] })
  assert.deepStrictEqual(chain2, [], 'Chinese chat should NOT trigger keyword fallback')

  // "dig stone" matches correctly
  const chain3 = buildIntentAwareChain({ goalText: 'dig stone', playerTexts: [] })
  assert.ok(chain3.length > 0, 'dig stone should match')
  assert.strictEqual(chain3[1]?.args?.block, 'stone')

  // Completely unrecognized English also returns empty
  const chain4 = buildIntentAwareChain({ goalText: 'explore the jungle biome', playerTexts: [] })
  assert.deepStrictEqual(chain4, [], 'vague English should return empty, not false-match')
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
