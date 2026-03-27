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

async function run() {
  await testEmptyExplicitIntentDoesNotSpinOnWait()
  await testSuppressWoodSkillWithoutWoodGoal()
  await testAllowsWoodWhenGoalMentionsWood()
  // eslint-disable-next-line no-console
  console.log('planner user intent suppress tests passed')
}

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err)
  process.exit(1)
})
