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

async function testIntentFallbackAlwaysReturnsEmpty() {
  const { buildIntentAwareChain } = require('../src/runtime/planning/intentFallback')

  // Per CLAUDE.md: all decisions go through LLM planner. intentFallback does NOT
  // do keyword-to-action mapping. It always returns [] — caller handles safe idle.
  const chain1 = buildIntentAwareChain({ goalText: '', playerTexts: ['come here'] })
  assert.deepStrictEqual(chain1, [], 'intentFallback must not match keywords — decisions belong to LLM')

  const chain2 = buildIntentAwareChain({ goalText: '', playerTexts: ['你是不是没看到树在哪？'] })
  assert.deepStrictEqual(chain2, [], 'Chinese chat returns empty')

  const chain3 = buildIntentAwareChain({ goalText: 'dig stone', playerTexts: [] })
  assert.deepStrictEqual(chain3, [], 'intentFallback must not match keywords')

  const chain4 = buildIntentAwareChain({ goalText: 'explore the jungle biome', playerTexts: [] })
  assert.deepStrictEqual(chain4, [], 'vague English returns empty')
}

async function testPersonalityWeightsSlotExists() {
  // Verify the personality weights parameter is accepted
  const sel = chooseHardcodedSkill({
    goal: 'attack zombie',
    snapshot: {
      threat_level: 'high', close_threat: true,
      status: { health: 20, food: 20, recentDamageMs: 2000 },
      inventory: { summary: [] },
    },
    personalityWeights: { aggression: 2.0, caution: 0.5 },
  })
  assert.strictEqual(sel?.name, 'attack_nearest_hostile', 'high aggression should favor attack')

  // With high caution + low aggression, retreat should win when low HP
  const sel2 = chooseHardcodedSkill({
    goal: '',
    snapshot: {
      threat_level: 'high', close_threat: true,
      status: { health: 6, food: 20, recentDamageMs: 1000 },
      inventory: { summary: [] },
    },
    personalityWeights: { aggression: 0.3, caution: 2.0 },
  })
  assert.strictEqual(sel2?.name, 'retreat_from_threat', 'high caution + low HP should favor retreat')
}

async function run() {
  await testEmptyExplicitIntentDoesNotSpinOnWait()
  await testSuppressWoodSkillWithoutWoodGoal()
  await testAllowsWoodWhenGoalMentionsWood()
  await testIntentFallbackAlwaysReturnsEmpty()
  await testPersonalityWeightsSlotExists()
  console.log('planner user intent suppress tests passed')
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
