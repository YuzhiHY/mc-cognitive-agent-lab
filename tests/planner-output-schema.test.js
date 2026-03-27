const assert = require('node:assert')
const { validatePlannerOutput, derivePlannerMeta } = require('../src/runtime/contracts/plannerOutput')

function testValidatePlannerOutput() {
  assert.strictEqual(validatePlannerOutput(null).ok, false)
  assert.strictEqual(validatePlannerOutput({}).ok, false)
  assert.strictEqual(validatePlannerOutput({ thought: 123 }).ok, false)
  assert.strictEqual(validatePlannerOutput({ thought: 'ok' }).ok, false)
  assert.strictEqual(validatePlannerOutput({ thought: 'ok', actionChain: [] }).ok, true)
}

function testDerivePlannerMetaSkillRef() {
  const decision = {
    thought: 'gather wood',
    actionChain: [
      { type: 'skill_ref', name: 'approach_target', args: {} },
      { type: 'skill_ref', name: 'mine_named_block', args: { block: 'oak_log' } },
    ],
    nextGoalHint: 'gather_wood',
  }
  const meta = derivePlannerMeta(decision)
  assert.strictEqual(meta.chosenSkill, 'approach_target')
  assert.deepStrictEqual(meta.chosenSkillChain, ['approach_target', 'mine_named_block'])
  assert.strictEqual(meta.requiresSynthesis, false)
  assert.strictEqual(meta.synthesisReason, null)
  assert.strictEqual(meta.goal, 'gather_wood')
}

function testDerivePlannerMetaSynthesis() {
  const decision = {
    thought: 'need custom behavior',
    actionChain: [
      { type: 'skill_ref', name: 'approach_target', args: {} },
      { type: 'skill', skillName: 'custom_bridge', code: 'module.exports.run = async () => {}' },
    ],
    nextGoalHint: 'build_bridge',
  }
  const meta = derivePlannerMeta(decision)
  assert.strictEqual(meta.chosenSkill, 'approach_target')
  assert.strictEqual(meta.requiresSynthesis, true)
  assert.ok(meta.synthesisReason.includes('1 skill step'))
}

function testDerivePlannerMetaEmpty() {
  const meta = derivePlannerMeta({ thought: 'idle', actionChain: [], nextGoalHint: null })
  assert.strictEqual(meta.chosenSkill, null)
  assert.deepStrictEqual(meta.chosenSkillChain, [])
  assert.strictEqual(meta.requiresSynthesis, false)
}

testValidatePlannerOutput()
testDerivePlannerMetaSkillRef()
testDerivePlannerMetaSynthesis()
testDerivePlannerMetaEmpty()
console.log('planner output schema tests passed')
